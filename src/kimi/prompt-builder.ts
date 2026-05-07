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
- **Type assertions**: flag \`as\` casts that bypass type safety without a comment explaining why
- **XSS sinks (critical)**: \`innerHTML\`, \`outerHTML\`, \`insertAdjacentHTML\`, \`document.write\`, or \`dangerouslySetInnerHTML\` assigned from any non-literal value — flag unless sanitized with a trusted library (e.g. DOMPurify)
- **Unsafe JSON.parse (warning)**: \`JSON.parse\` on data from fetch responses, URL params, localStorage, or postMessage without try-catch and schema validation — malformed input throws and unvalidated structure causes runtime errors
- **Prototype pollution (critical)**: \`Object.assign({}, userInput)\`, recursive merge utilities, or bracket notation property writes (\`obj[key] = val\`) where \`key\` is user-controlled — attacker can set \`__proto__\` or \`constructor\`
- **setTimeout/setInterval with string (warning)**: passing a string instead of a function to \`setTimeout\`/\`setInterval\` is implicit \`eval\` — always use a function reference`,

  JavaScript: `### JavaScript
- Same null/async/error/XSS/prototype-pollution rules as TypeScript
- Flag missing \`'use strict'\` in CommonJS modules that manipulate shared state
- Flag prototype mutation in library code`,

  Python: `### Python
- **Mutable default arguments**: \`def f(x=[])\` or \`def f(x={})\` is a classic bug — flag every mutable default
- **Exception handling**: bare \`except:\` or \`except Exception: pass\` hides bugs — must be specific and handle or re-raise
- **Resource management**: file/socket/db handles must use context managers (\`with\` statement); flag \`open()\` without \`with\`
- **Wildcard imports**: \`from x import *\` in non-\`__init__.py\` files pollutes the namespace — flag it
- **None comparisons**: use \`is None\` / \`is not None\`, not \`== None\`
- **Insecure deserialization (critical)**: \`pickle.loads\`, \`pickle.load\`, \`shelve\`, or \`marshal.loads\` on any data not generated by the same process — arbitrary code execution
- **Shell injection (critical)**: \`subprocess.run\`, \`subprocess.call\`, \`os.system\`, \`os.popen\` with \`shell=True\` and any variable in the command string — use list form instead
- **Unsafe eval (critical)**: \`eval()\` or \`exec()\` on any string derived from user input, environment variables, or external files
- **Unsafe YAML (critical)**: \`yaml.load(data)\` without \`Loader=yaml.SafeLoader\` (or use \`yaml.safe_load\`) — allows arbitrary Python object instantiation`,

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
// Framework-specific rules
// ---------------------------------------------------------------------------

const FRAMEWORK_RULES: Array<{ match: RegExp; rule: string }> = [
  {
    match: /react/i,
    rule: `### React
- **XSS via dangerouslySetInnerHTML (critical)**: any use of \`dangerouslySetInnerHTML={{ __html: value }}\` where \`value\` is not a hardcoded literal — must be sanitized with DOMPurify or equivalent before use
- **useEffect cleanup (warning)**: effects that set up subscriptions, timers, or event listeners without returning a cleanup function leak memory and cause stale-closure bugs
- **Missing key in lists (warning)**: array \`.map()\` rendering JSX without a stable \`key\` prop causes reconciliation bugs — never use array index as key for lists that can reorder or filter
- **Expensive computation without useMemo (suggestion)**: heavy derivations or object/array literals created inline in render re-run every cycle — wrap with \`useMemo\`/\`useCallback\` if passed to memoized children`,
  },
  {
    match: /next\.?js|nextjs/i,
    rule: `### Next.js
- **Server Action input validation (critical)**: Server Actions receive data directly from the client — always validate and sanitize inputs with Zod or equivalent before using them in DB queries or business logic
- **getServerSideProps / loader data exposure (critical)**: any secrets, internal tokens, or full DB records returned from \`getServerSideProps\` / \`loader\` are serialized into the page HTML — return only the minimum fields the UI needs
- **Missing auth on API routes (critical)**: every \`/api/\` route and Server Action that performs mutations or returns sensitive data must verify the session before proceeding
- **Open redirect via \`next/navigation\` (warning)**: \`redirect()\` or \`router.push()\` with a URL derived from query params or user input — validate the destination is a relative path or an allowlisted domain`,
  },
  {
    match: /django/i,
    rule: `### Django
- **Raw SQL (critical)**: \`.raw()\`, \`cursor.execute()\`, or \`extra()\` with string formatting or \`%\` interpolation of user data — use parameterized queries (\`cursor.execute(sql, [params])\`)
- **CSRF exemption (warning)**: \`@csrf_exempt\` on a state-mutating view must have an explicit reason — flag for review
- **DEBUG = True in non-dev settings (critical)**: exposes full stack traces, SQL queries, and settings to users — ensure \`DEBUG\` is \`False\` in production settings files
- **Mass assignment via ModelForm (warning)**: \`ModelForm\` without an explicit \`fields\` list (or with \`fields = '__all__'\`) allows attackers to set any model field`,
  },
  {
    match: /fastapi/i,
    rule: `### FastAPI
- **Pydantic model bypass (critical)**: accepting \`dict\` or \`Any\` as a request body type instead of a typed Pydantic model skips input validation entirely
- **Missing dependency injection for auth (critical)**: route functions that access user data without a \`Depends(get_current_user)\` or equivalent dependency are unauthenticated
- **Response model data leakage (warning)**: returning an ORM object directly without a \`response_model\` can leak fields (e.g. hashed passwords) not intended for the client — always declare \`response_model\``,
  },
  {
    match: /kysely/i,
    rule: `### Kysely
- **Raw SQL injection (critical)**: \`sql\`...\`\` template literals or \`db.raw()\` with user input interpolated directly — always use Kysely's parameterized value helpers (\`sql\`${'\`'}value${'\`'}\` or bound \`eb\` expressions) instead of string interpolation
- **Missing transaction on multi-step mutations (warning)**: two or more dependent writes that must succeed together (e.g. insert + update) should use \`db.transaction().execute()\` — partial completion leaves the DB in an inconsistent state
- **Unbounded selectAll (warning)**: \`.selectAll()\` or queries without \`.limit()\` on tables that grow unboundedly — always add pagination or an explicit limit to prevent memory exhaustion and slow queries
- **selectAll leaking sensitive columns (warning)**: \`.selectAll()\` on tables containing password hashes, tokens, or PII returned to the API layer — explicitly select only the columns the caller needs`,
  },
  {
    match: /tanstack.?query|react.?query/i,
    rule: `### TanStack Query / React Query
- **Stale auth-sensitive data (warning)**: queries for user-specific or permission-gated data should set \`staleTime: 0\` or be invalidated on auth state change — stale cache can show one user's data to another in shared-device scenarios
- **Missing error boundary (suggestion)**: query errors that are not caught by an \`<ErrorBoundary>\` or an \`onError\` handler will bubble as unhandled rejections — wrap data-fetching trees with error boundaries`,
  },
  {
    match: /gin|echo|fiber/i,
    rule: `### Go HTTP Framework (Gin / Echo / Fiber)
- **Binding without validation (critical)**: \`c.ShouldBind\` / \`c.Bind\` without subsequent struct validation (\`validate.Struct\`) accepts any shape of input — always validate after binding
- **Missing auth middleware on route groups (critical)**: route groups that expose sensitive endpoints must have auth middleware applied at the group level, not just per-route
- **c.JSON with raw user data (warning)**: returning user-supplied structs directly without field filtering can leak internal fields — use response DTOs`,
  },
  {
    match: /rspack|rsbuild/i,
    rule: `### Rspack / Rsbuild
- **Hardcoded secrets in define/env (critical)**: values injected via \`define\` or \`source.define\` that contain API keys, tokens, or private URLs are inlined into the client bundle and publicly visible — use public-prefix conventions and never inject server-only secrets
- **Overly broad publicDir (warning)**: serving an entire directory (e.g. the repo root) as static assets via \`output.copy\` or \`html.template\` misconfiguration can expose source files — scope publicDir to only the intended static assets folder
- **Sourcemaps in production (warning)**: \`devtool: 'source-map'\` in a production build exposes original source code to anyone with browser devtools — use \`hidden-source-map\` or disable sourcemaps for production`,
  },
  {
    match: /tanstack.?router/i,
    rule: `### TanStack Router
- **Unvalidated search params (warning)**: route search params read via \`useSearch()\` without a \`validateSearch\` schema (e.g. Valibot/Zod) are untyped \`unknown\` at runtime — always define a validator on the route to prevent crashes from malformed URLs
- **Sensitive data in search params (warning)**: tokens, IDs, or PII stored in search params appear in the URL, browser history, and server logs — use navigation state or session storage for sensitive values
- **Missing notFound / errorComponent on data routes (suggestion)**: loader-driven routes without \`notFoundComponent\` / \`errorComponent\` will white-screen on fetch failure — add explicit fallback components`,
  },
  {
    match: /\bky\b/i,
    rule: `### ky (HTTP client)
- **Missing error handling on ky requests (warning)**: \`ky.get(...).json()\` without a \`.catch()\` or try-catch — \`ky\` throws \`HTTPError\` on non-2xx responses and the error contains the response body; unhandled it crashes the calling code
- **Credentials on cross-origin requests (warning)**: \`ky.extend({ credentials: 'include' })\` on an instance used for third-party APIs sends cookies cross-origin — scope credentialed instances to first-party origins only
- **Unbounded retry on mutating requests (warning)**: \`retry\` option enabled on POST/PUT/PATCH/DELETE without idempotency guarantees can cause duplicate writes — set \`retry: 0\` or restrict retries to GET requests`,
  },
  {
    match: /openapi|swagger/i,
    rule: `### OpenAPI
- **Unauthenticated endpoints (critical)**: any path in the spec without a \`security\` field (or with \`security: []\`) that performs mutations or returns non-public data is publicly accessible — every non-public operation must declare a security scheme
- **Missing input validation on request bodies (critical)**: request body schemas without \`minLength\`, \`minimum\`, \`maxLength\`, \`maximum\`, \`pattern\`, or \`enum\` constraints on user-supplied fields leave validation entirely to the implementation — define constraints in the schema so generated validators and docs are accurate
- **Sensitive data in query params (warning)**: tokens, passwords, or PII defined as query parameters in the spec will appear in server logs and browser history — use request body or Authorization header instead
- **Overly broad response schema (warning)**: response schemas using \`additionalProperties: true\` or returning the full DB model shape may leak internal fields — define explicit response schemas with only the fields the client needs
- **Missing 401/403 responses (suggestion)**: operations that declare a security requirement but don't document \`401\` and \`403\` response codes produce misleading generated clients — always document auth error responses`,
  },
  {
    match: /oidc-client|oidc.?client.?ts/i,
    rule: `### oidc-client-ts
- **Storing tokens in localStorage (critical)**: \`UserManager\` configured with \`userStore: new WebStorageStateStore({ store: localStorage })\` exposes tokens to XSS — use the default \`sessionStorage\` or a service-worker-based silent renew with in-memory storage
- **Missing PKCE (critical)**: authorization flows without \`response_type: 'code'\` and PKCE (the library default) fall back to implicit flow — verify \`response_type\` is \`'code'\` and \`automaticSilentRenew\` is not overriding it
- **Unchecked signinRedirectCallback (critical)**: \`userManager.signinRedirectCallback()\` result must be awaited and errors caught — an unhandled rejection on a tampered state parameter silently leaves the user unauthenticated
- **Open redirect after login (warning)**: \`state\` or \`redirect_uri\` values passed to \`signinRedirect\` derived from \`window.location\` or query params without validating the destination is a same-origin path — attacker can redirect the post-login flow to a phishing page
- **Expired/missing user check (warning)**: reading \`user.access_token\` from \`userManager.getUser()\` without checking \`user !== null && !user.expired\` will pass a stale or null token to API calls — always validate before use`,
  },
  {
    match: /valibot/i,
    rule: `### Valibot
- **parse vs safeParse (warning)**: \`v.parse(schema, data)\` throws on invalid input — in request handlers or user-facing flows use \`v.safeParse()\` and handle the error branch explicitly rather than letting it bubble as an unhandled exception
- **Missing schema on external data (critical)**: data from fetch responses, URL params, localStorage, or postMessage used without passing through a Valibot schema — always validate external data at the boundary before use
- **Overly permissive schema (warning)**: \`v.any()\`, \`v.unknown()\`, or \`v.record(v.string(), v.any())\` at the top level of a request schema defeats the purpose of validation — tighten to the specific shape expected`,
  },
];

function buildFrameworkRulesSection(frameworks: string[]): string {
  if (frameworks.length === 0) return '';
  const matched = FRAMEWORK_RULES.filter((fr) =>
    frameworks.some((f) => fr.match.test(f)),
  ).map((fr) => fr.rule);
  if (matched.length === 0) return '';
  return `## Framework-Specific Rules\n${matched.join('\n\n')}`;
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
// Bug patterns checklist (always included)
// ---------------------------------------------------------------------------

const BUG_PATTERNS_CHECKLIST = `## Bug Patterns Checklist
Always check for these regardless of which review dimensions are enabled:
- **Off-by-one (warning)**: loop bounds using \`<\` vs \`<=\`, array slice indices, pagination \`offset\` calculations, and fence-post errors in range checks — these are the most common source of subtle data truncation and index-out-of-bounds bugs
- **Race condition / TOCTOU (critical)**: check-then-act patterns where state can change between the check and the action (e.g. \`if (file.exists()) file.read()\`, reading then writing a shared counter without atomicity, or \`getUser()\` then mutating based on the result without re-validating)
- **Integer overflow in numeric operations (warning)**: arithmetic on values that could be large (IDs, financial amounts, counts) without bounds checking — in JavaScript all numbers are float64 so integers above 2^53 lose precision; use \`BigInt\` for large integer math
- **ReDoS — catastrophic regex backtracking (warning)**: regular expressions with nested quantifiers (e.g. \`(a+)+\`, \`(.*a){n}\`) applied to user-supplied input — a crafted string can cause exponential backtracking and hang the process; prefer linear-time alternatives or add input length limits
- **Incorrect comparison operator (warning)**: loose equality (\`==\`) where strict (\`===\`) is needed, assignment (\`=\`) inside a condition, or reversed comparator in a sort callback (\`a - b\` vs \`b - a\`) causing incorrect ordering`;

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
  const frameworkRules = buildFrameworkRulesSection(walkthrough.detectedFrameworks);
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

${BUG_PATTERNS_CHECKLIST}

${SECURITY_CHECKLIST}

${PERFORMANCE_CHECKLIST}

## Cross-File Analysis
When multiple changed files are provided, look for issues that only appear when files are read together:
- A function introduced or modified in one file that is called from a route/handler in another file — check whether input validation happens before the call, not just inside the function
- Shared module-level mutable state (exported \`let\`, singleton objects, module-level caches) written from one file and read from another without synchronization
- Auth or permission checks applied in some call sites but not all — if a utility is called from both an authenticated and an unauthenticated context, flag the unguarded path
- Type mismatches at call boundaries — a function changed to return \`null\` in one file while callers in other files still assume a non-null return

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
- Score calibration: start at 100 and deduct — **critical finding: −15 each** (security critical: −20 each), **warning: −5 each**, **suggestion: −1 each**, **nitpick: 0**. A single critical security finding caps the score at 60 regardless of other findings. Final score ranges: 90–100 = production-ready with at most minor suggestions; 75–89 = mergeable but has warnings worth fixing; 50–74 = real issues that should be addressed before merge; below 50 = significant bugs or security vulnerabilities present

## False Positive Prevention
- Read the full file content provided as context before flagging an issue — the code may be correct in context
- Do not flag missing error handling if the caller visibly handles the error
- Do not flag missing tests unless \`testing\` is in the review dimensions
- Do not flag missing documentation unless \`documentation\` is in the review dimensions
- Do not flag issues in deleted lines — they are being removed
${langRules ? `\n${langRules}` : ''}${frameworkRules ? `\n\n${frameworkRules}` : ''}${suppressions ? `\n\n${suppressions}` : ''}${config.prompt.reviewFocus ? `\n\n## Review Focus\n${config.prompt.reviewFocus}` : ''}${customRules ? `\n\n## Repository Rules\n${customRules}` : ''}${config.prompt.systemAppend ? `\n\n## Additional Instructions\n${config.prompt.systemAppend}` : ''}`;

  return buildCacheOptimizedMessages(system, ctx, config, fileContents ?? ctx.fileContents);
}
