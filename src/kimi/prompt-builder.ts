import type { ChatMessage, PullRequestContext, ChangedFile, WalkthroughResult } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { buildCacheOptimizedMessages } from './cache-strategy.js';

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const EXTENSION_MAP: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  py: 'Python',
  go: 'Go',
  rb: 'Ruby',
  java: 'Java',
  kt: 'Kotlin',
  kts: 'Kotlin',
  rs: 'Rust',
  cs: 'C#',
  cpp: 'C++',
  cc: 'C++',
  cxx: 'C++',
  h: 'C++',
  hpp: 'C++',
  c: 'C',
  php: 'PHP',
  swift: 'Swift',
  scala: 'Scala',
  sh: 'Shell',
  bash: 'Shell',
  sql: 'SQL',
  yaml: 'YAML',
  yml: 'YAML',
};

export function detectLanguages(changedFiles: ChangedFile[]): string[] {
  const langs = new Set<string>();
  for (const f of changedFiles) {
    const ext = f.filename.split('.').pop()?.toLowerCase() ?? '';
    const lang = EXTENSION_MAP[ext];
    if (lang) langs.add(lang);
  }
  return [...langs];
}

// ---------------------------------------------------------------------------
// Pass 1: Walkthrough prompt
// ---------------------------------------------------------------------------

const WALKTHROUGH_JSON_SCHEMA = `{
  "prSummary": "string — 2–4 sentences explaining what this PR does and why",
  "walkthrough": [
    {
      "path": "string — file path relative to repo root",
      "summary": "string — 1–2 sentences describing what logic changed in this file",
      "changeType": "added | modified | removed | renamed"
    }
  ],
  "detectedLanguages": ["string — programming languages present in the changed files"],
  "detectedFrameworks": ["string — frameworks/libraries inferred from imports or file names"]
}`;

export function buildWalkthroughMessages(ctx: PullRequestContext): ChatMessage[] {
  const system = `You are a senior engineer reading a pull request for the first time.
Your task is NOT to find bugs — it is to understand what the PR does and summarize it clearly.

## Output Format
Respond with a single JSON object matching this schema:
${WALKTHROUGH_JSON_SCHEMA}

## Instructions
- prSummary: explain the purpose and scope of the PR in plain English (2–4 sentences)
- walkthrough: one entry per changed file — describe what logic changed, not just "file modified"
- detectedLanguages: list all programming languages present (e.g. TypeScript, Python, Go)
- detectedFrameworks: list frameworks/libraries you can infer from imports or file names
  (e.g. React, Next.js, FastAPI, Django, Express, Gin, Spring)
- If a file was deleted, describe what was removed and why that makes sense in context
- If there are more than 30 changed files, include entries for the 20 most significant ones
- Do NOT flag any issues or mention code quality — this pass is purely descriptive`;

  const fileSummary = ctx.changedFiles
    .map((f) => `- ${f.filename} (+${f.additions}/-${f.deletions}) [${f.status}]`)
    .join('\n');

  const user = [
    `## Pull Request #${ctx.pullNumber}: ${ctx.title}`,
    ctx.body ? `\n### Description\n${ctx.body}` : '',
    `\n### Changed Files (${ctx.changedFiles.length} files)\n${fileSummary}`,
    `\n### Diff\n\`\`\`diff\n${ctx.diff}\n\`\`\``,
    '\nSummarize this PR.',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---------------------------------------------------------------------------
// Language-specific rules
// ---------------------------------------------------------------------------

const LANGUAGE_RULES: Record<string, string> = {
  TypeScript: `### TypeScript / JavaScript
- **Null safety**: prefer nullish coalescing (??) and optional chaining (?.) over loose equality (== null); flag \`as any\`, \`as unknown as X\`, and untyped parameters
- **Async safety**: every Promise-returning call inside a non-async callback must be awaited or have .catch(); flag fire-and-forget patterns in critical paths
- **Error handling**: empty catch blocks (\`catch {}\` or \`catch (e) {}\` with no body) silently hide bugs — flag them as critical
- **React hooks** (if applicable): hooks must not be called conditionally; useEffect dependency arrays must be exhaustive; flag stale closures
- **Promise semantics**: flag \`Promise.all\` when partial failure should not abort — suggest \`Promise.allSettled\`
- **Type assertions**: flag \`as\` casts that bypass type safety without a comment explaining why`,

  JavaScript: `### JavaScript
- Same null/async/error rules as TypeScript
- Flag missing \`'use strict'\` in CommonJS modules that manipulate shared state
- Flag prototype mutation in library code`,

  Python: `### Python
- **Mutable default arguments**: \`def f(x=[])\` or \`def f(x={})\` is a classic bug — flag every mutable default
- **Exception handling**: bare \`except:\` or \`except Exception: pass\` hides bugs — must be specific and handle or re-raise
- **Resource management**: file/socket/db handles must use context managers (\`with\` statement); flag \`open()\` without \`with\`
- **Wildcard imports**: \`from x import *\` in non-\`__init__.py\` files pollutes the namespace — flag it
- **None comparisons**: use \`is None\` / \`is not None\`, not \`== None\``,

  Go: `### Go
- **Error handling**: every error return must be checked; discarding errors with \`_\` is forbidden except in tests — flag as critical
- **Goroutine safety**: flag shared map/slice writes without mutex; flag goroutines that outlive their context
- **Context propagation**: functions that make I/O calls must accept \`context.Context\` as the first parameter
- **Defer in loops**: \`defer\` inside a loop does not execute until function return, not loop iteration — flag this pattern
- **Nil pointer**: always check pointer/interface returns before dereference
- **Panic**: \`panic()\` must not be used for normal error flows in library or service code`,

  Ruby: `### Ruby
- \`rescue Exception\` swallows OS signals — flag it; \`rescue StandardError\` is correct
- Flag \`CONST = []\` — mutable constants are misleading; use \`freeze\`
- Flag N+1 query patterns in ActiveRecord (\`.each { Model.where(...) }\`)`,

  Java: `### Java
- **NullPointerException**: flag missing null checks on method returns that may be null; prefer Optional
- **Resource leaks**: streams, connections, and readers must use try-with-resources
- **Thread safety**: flag unsynchronized access to shared mutable state across threads
- **Optional misuse**: \`Optional.get()\` without \`isPresent()\` check is a NPE waiting to happen`,

  Kotlin: `### Kotlin
- Flag \`!!\` (non-null assertion) outside of test code — suggest null-safe alternatives
- Flag \`lateinit var\` without a clear initialization guarantee
- Coroutine scope leaks: flag \`GlobalScope.launch\` in production code`,

  Rust: `### Rust
- \`.unwrap()\` and \`.expect()\` are only acceptable in tests and \`main()\` — flag in library code; suggest \`?\` operator or proper error handling
- Flag unnecessary \`.clone()\` on \`Copy\` types
- Flag \`unsafe\` blocks without a safety comment explaining the invariant`,

  'C#': `### C#
- **Async void**: \`async void\` methods cannot be awaited and swallow exceptions — flag except for event handlers
- **IDisposable**: classes owning unmanaged resources must implement \`IDisposable\` with \`using\` at call sites
- **LINQ deferred execution**: flag patterns that enumerate a query multiple times without \`.ToList()\`/\`.ToArray()\``,

  PHP: `### PHP
- Flag SQL queries built with string concatenation — use prepared statements
- Flag \`@\` error suppression operator — handle errors explicitly
- Flag \`extract()\` and \`eval()\` — these are security risks`,

  Swift: `### Swift
- Flag force unwrap (\`!\`) outside of tests — use \`guard let\` or \`if let\`
- Flag retain cycles in closures — \`[weak self]\` capture list where needed`,

  Shell: `### Shell / Bash
- Flag unquoted variable expansions (\`$var\` → \`"$var"\`) — word splitting bugs
- Flag missing \`set -e\` / \`set -o pipefail\` in scripts where partial failure should abort
- Flag \`rm -rf\` with unquoted or user-supplied path variables`,
};

function buildLanguageRulesSection(languages: string[]): string {
  const rules = languages.map((lang) => LANGUAGE_RULES[lang]).filter(Boolean);
  if (rules.length === 0) return '';
  return `## Language-Specific Rules\n${rules.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// Suppression rules
// ---------------------------------------------------------------------------

function buildSuppressionsSection(config: ReviewConfig): string {
  if (!config.suppressions || config.suppressions.length === 0) return '';

  const lines: string[] = ['## Suppression Rules — Do NOT Flag These'];
  for (const s of config.suppressions) {
    let line = `- "${s.pattern}"`;
    if (s.filePattern) line += ` (only suppressed in files matching: ${s.filePattern})`;
    if (s.reason) line += ` — Reason: ${s.reason}`;
    lines.push(line);
  }
  lines.push('\nIf an issue matches a suppression pattern, omit it entirely from annotations.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Security checklist (always included, language-agnostic)
// ---------------------------------------------------------------------------

const SECURITY_CHECKLIST = `## Security Checklist
Always check for these attack vectors regardless of which review dimensions are enabled:
- **Injection (critical)**: SQL/NoSQL queries built with string concatenation or template literals containing user input — verify parameterized queries or prepared statements are used
- **Command injection (critical)**: \`child_process.exec\`, \`subprocess.run(shell=True)\`, \`os.system\`, or similar with any user-controlled input
- **XSS (critical)**: unsanitized user input rendered via \`innerHTML\`, \`dangerouslySetInnerHTML\`, \`document.write\`, or \`eval\` — verify escaping or sanitization
- **SSRF (critical)**: HTTP/fetch requests where the URL or host is derived from user input without an allowlist — attacker can reach internal services
- **Path traversal (critical)**: file-system operations where the path includes user input without \`path.resolve\` + strict prefix validation
- **Authentication/authorization (critical)**: new routes or endpoints missing auth middleware; privilege escalation patterns; JWTs decoded without verifying the signature
- **Hardcoded secrets (critical)**: API keys, passwords, tokens, or private keys committed directly in source code
- **Insecure deserialization (critical)**: \`pickle.loads\`, \`yaml.load\` (not \`yaml.safe_load\`), \`eval()\`, or \`JSON.parse\` on unvalidated data from external sources
- **Mass assignment (critical)**: object spread (\`{ ...req.body }\`) or \`Object.assign\` with unfiltered user input bound directly to a database model
- **Sensitive data exposure (critical)**: PII, credentials, or secrets written to logs, returned verbatim in API responses, or stored without encryption`;

// ---------------------------------------------------------------------------
// Performance checklist (always included)
// ---------------------------------------------------------------------------

const PERFORMANCE_CHECKLIST = `## Performance Checklist
Always check for these patterns regardless of which review dimensions are enabled:
- **N+1 queries (warning)**: database or API calls inside a loop (\`.forEach\`, \`for\`, \`.map\`, \`.each\`) — suggest batching with \`whereIn\`, \`include\`/\`eager_load\`, or \`Promise.all\`
- **Blocking I/O in async context (warning)**: synchronous file/network operations (\`fs.readFileSync\`, \`execSync\`, \`requests.get\` on a hot path) inside async functions or request handlers
- **Unbounded queries (warning)**: database queries or external API calls without \`LIMIT\`, pagination, or a result-size cap on collections that could grow large
- **Sequential awaits that could be parallel (suggestion)**: multiple independent \`await\` calls in sequence inside a loop or handler where \`Promise.all\` would be faster
- **Event loop blocking (warning)**: CPU-intensive synchronous work (large sort, deep JSON serialization, regex on untrusted input) executed on the main thread in a Node.js/server context`;

// ---------------------------------------------------------------------------
// Pass 2: Deep review prompt
// ---------------------------------------------------------------------------

const REVIEW_JSON_SCHEMA = `{
  "summary": "string — overall review summary in markdown (2–5 sentences)",
  "score": "number 0-100 — code quality score",
  "annotations": [
    {
      "path": "string — file path relative to repo root",
      "startLine": "number — starting line number (1-indexed, must be a line present in the diff)",
      "endLine": "number — ending line number (>= startLine)",
      "severity": "critical | warning | suggestion | nitpick",
      "category": "bug | security | performance | style | best-practice | documentation | testing | other",
      "title": "string — short issue title (max 80 chars)",
      "body": "string — detailed explanation in markdown; reference exact variable/function names",
      "suggestedFix": "string | null"
    }
  ]
}`;

export function buildDeepReviewMessages(
  ctx: PullRequestContext,
  config: ReviewConfig,
  walkthrough: WalkthroughResult,
  fileContents?: Map<string, string>,
): ChatMessage[] {
  const aspects = Object.entries(config.review.aspects)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name)
    .join(', ');

  const customRules = config.rules
    .map((r) => `- [${r.severity}] ${r.name}: ${r.description}`)
    .join('\n');

  const langRules = buildLanguageRulesSection(walkthrough.detectedLanguages);
  const suppressions = buildSuppressionsSection(config);

  const walkthroughCtx = [
    walkthrough.prSummary ? `**PR Purpose:** ${walkthrough.prSummary}` : '',
    walkthrough.detectedLanguages.length > 0
      ? `**Languages:** ${walkthrough.detectedLanguages.join(', ')}`
      : '',
    walkthrough.detectedFrameworks.length > 0
      ? `**Frameworks:** ${walkthrough.detectedFrameworks.join(', ')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  const system = `You are an expert code reviewer performing a thorough review of a pull request.
You already understand the PR's intent from a prior analysis. Your job is to find real bugs, security vulnerabilities, and meaningful improvements — while avoiding noise.

## PR Context
${walkthroughCtx || 'No walkthrough context available.'}

## Review Dimensions
Focus on: ${aspects}

## Severity Definitions
- **critical**: Bugs that will cause failures, security vulnerabilities, data loss risks — must fix before merge
- **warning**: Performance issues, potential bugs, bad practices — should fix
- **suggestion**: Code improvements, readability, maintainability — nice to have
- **nitpick**: Style preferences, minor formatting — optional

${SECURITY_CHECKLIST}

${PERFORMANCE_CHECKLIST}

## Output Format
Return only a single valid JSON object matching this schema:
${REVIEW_JSON_SCHEMA}

## Core Rules
- **Only annotate lines present in the diff** — lines beginning with \`+\` (added/modified). Never annotate deleted lines (\`-\`) or context lines.
- Be specific: reference exact variable names, function names, and line numbers
- summary describes overall quality and key themes — not a list of every finding
- Keep annotation titles concise (under 80 characters)

## CRITICAL: suggestedFix Format

The \`suggestedFix\` field is rendered by GitHub as a one-click "Apply suggestion" button that **directly replaces lines startLine through endLine** in the file. It must be valid, compilable code.

**GOOD example** — annotation on line 42 which contains \`const result = getValue() ?? null\`:
\`\`\`
"suggestedFix": "  const result = getValue() ?? undefined"
\`\`\`
(preserves the original indentation, is a single line because endLine == startLine)

**BAD example** — this is prose, not code — it will corrupt the file if applied:
\`\`\`
"suggestedFix": "Replace null with undefined to match the return type"
\`\`\`

**Rules for suggestedFix:**
1. Must be the exact replacement source code for lines startLine through endLine
2. Preserve the original indentation exactly (spaces/tabs)
3. Must contain exactly (endLine - startLine + 1) lines — same count as the annotated range
4. No diff markers (+/-), no line numbers, no markdown — only the raw code
5. Must be syntactically valid in the file's language
6. If the fix requires structural changes spanning many lines or files, set suggestedFix to null

## Precision Over Volume
- Prefer 5 high-confidence, actionable findings over 20 speculative ones
- Do not flag issues that are clearly intentional (TODO comments, disabled lint rules with explanations, performance trade-offs documented in comments)
- Consider the PR's purpose: if it is a hotfix, style-level suggestions are noise; focus on correctness
- If a pattern appears consistently across many files in this PR, it is likely intentional — flag it once as a suggestion, not as critical/warning — **exception: security and bug findings are never de-escalated regardless of how many files they appear in; each instance must be flagged at its true severity**
- Score: 90–100 = no real bugs/security issues; 70–89 = minor warnings; 50–69 = real issues; <50 = significant bugs; security vulnerabilities anchor the score down — a single critical security issue caps the score at 60

## False Positive Prevention
- Read the full file content provided as context before flagging an issue — the code may be correct in context
- Do not flag missing error handling if the caller visibly handles the error
- Do not flag missing tests unless \`testing\` is in the review dimensions
- Do not flag missing documentation unless \`documentation\` is in the review dimensions
- Do not flag issues in deleted lines — they are being removed
${langRules ? `\n${langRules}` : ''}${suppressions ? `\n\n${suppressions}` : ''}${config.prompt.reviewFocus ? `\n\n## Review Focus\n${config.prompt.reviewFocus}` : ''}${customRules ? `\n\n## Repository Rules\n${customRules}` : ''}${config.prompt.systemAppend ? `\n\n## Additional Instructions\n${config.prompt.systemAppend}` : ''}`;

  return buildCacheOptimizedMessages(system, ctx, config, fileContents ?? ctx.fileContents);
}
