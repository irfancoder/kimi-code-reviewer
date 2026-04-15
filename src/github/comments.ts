import type { Octokit } from '@octokit/rest';
import type { ReviewAnnotation, ReviewResult, Severity, WalkthroughResult } from '../types/review.js';
import { calculateCost } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
  nitpick: '⚪',
};

export async function createPRReview(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitSha: string;
    result: ReviewResult;
    failOn: 'critical' | 'warning' | 'never';
    provider?: string;
    model?: string;
    baseUrl?: string;
  },
): Promise<void> {
  const { owner, repo, pullNumber, commitSha, result, failOn, provider, model, baseUrl } = params;

  const shouldRequestChanges =
    failOn === 'critical'
      ? result.stats.critical > 0
      : failOn === 'warning'
        ? result.stats.critical > 0 || result.stats.warning > 0
        : false;

  const event = shouldRequestChanges ? 'REQUEST_CHANGES' : 'COMMENT';

  const body = buildReviewBody(result, { provider, model, baseUrl });

  // Create the review with inline comments
  const comments = result.annotations
    .filter((a) => a.severity !== 'nitpick') // nitpicks only go to Check annotations
    .map((a) => ({
      path: a.path,
      line: a.endLine,
      side: 'RIGHT' as const,
      body: formatAnnotationComment(a),
    }));

  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      event,
      body,
      comments,
    });

    logger.info(
      { pullNumber, event, commentCount: comments.length },
      'PR review created',
    );
  } catch (err) {
    // If inline comments fail (e.g., line not in diff), fall back to body-only review
    logger.warn({ err }, 'Failed to create review with inline comments, falling back');
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitSha,
      event,
      body: body + '\n\n> _Note: Some inline comments could not be placed on the diff._',
    });
  }
}

function buildReviewBody(
  result: ReviewResult,
  pricingContext?: { provider?: string; model?: string; baseUrl?: string },
): string {
  const cost = calculateCost(result.tokensUsed, pricingContext);
  const lines: string[] = [];

  lines.push('## 🤖 FiscalCR Code Review\n');
  lines.push(result.summary);
  lines.push('');
  lines.push(`**Score:** ${result.score}/100`);
  lines.push('');
  lines.push('| Severity | Count |');
  lines.push('|----------|-------|');
  for (const [severity, count] of Object.entries(result.stats)) {
    if (count > 0) {
      lines.push(`| ${SEVERITY_EMOJI[severity as Severity]} ${severity} | ${count} |`);
    }
  }

  lines.push('');
  lines.push('<details>');
  lines.push('<summary>Token Usage & Cost</summary>\n');
  lines.push(`- Input: ${result.tokensUsed.input.toLocaleString()} tokens`);
  lines.push(`- Output: ${result.tokensUsed.output.toLocaleString()} tokens`);
  lines.push(`- Cached: ${result.tokensUsed.cached.toLocaleString()} tokens`);
  lines.push(`- Estimated cost: $${cost}`);
  lines.push('</details>\n');

  lines.push('---');
  lines.push('*Powered by [Kimi Code Reviewer](https://github.com/kimi-code-reviewer/kimi-code-reviewer) — Moonshot AI 256K context*');

  return lines.join('\n');
}

function formatAnnotationComment(a: ReviewAnnotation): string {
  const parts: string[] = [];
  parts.push(`${SEVERITY_EMOJI[a.severity]} **[${a.severity}]** ${a.title}\n`);
  parts.push(a.body);

  if (a.suggestedFix) {
    // Trim leading/trailing newlines — the model sometimes adds them, which would shift the
    // line count and prevent GitHub from rendering a one-click "Apply suggestion" button.
    const fix = a.suggestedFix.replace(/^[\r\n]+|[\r\n]+$/g, '');
    const fixLines = fix.split('\n').length;
    const annotatedLines = a.endLine - a.startLine + 1;

    if (fixLines === annotatedLines) {
      // Valid drop-in suggestion — GitHub renders this as a one-click "Apply suggestion" button
      parts.push('\n**Suggested fix:**');
      parts.push('```suggestion');
      parts.push(fix);
      parts.push('```');
    } else {
      // Line count mismatch — render as a plain code block to avoid corrupting the file
      const lang = langFromPath(a.path);
      parts.push('\n**Suggested fix** (manual apply — line count differs from annotated range):');
      parts.push(`\`\`\`${lang}`);
      parts.push(fix);
      parts.push('```');
    }
  }

  return parts.join('\n');
}

function langFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    py: 'python',
    go: 'go',
    rb: 'ruby',
    java: 'java',
    kt: 'kotlin',
    rs: 'rust',
    cs: 'csharp',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', h: 'cpp', hpp: 'cpp',
    c: 'c',
    php: 'php',
    swift: 'swift',
    sh: 'bash', bash: 'bash',
    sql: 'sql',
  };
  return map[ext] ?? '';
}

// ---------------------------------------------------------------------------
// Walkthrough comment
// ---------------------------------------------------------------------------

const WALKTHROUGH_MARKER = '## Kimi Code Review — PR Walkthrough';

export async function createWalkthroughComment(
  octokit: Octokit,
  params: {
    owner: string;
    repo: string;
    pullNumber: number;
    walkthrough: WalkthroughResult;
    changedFilePaths: string[];
  },
): Promise<void> {
  const { owner, repo, pullNumber, walkthrough, changedFilePaths } = params;
  const body = buildWalkthroughBody(walkthrough, changedFilePaths);

  try {
    // Look for an existing walkthrough comment to update instead of stacking new ones.
    // Paginate through all comments so we don't miss it on active PRs with >100 comments.
    let existing: { id: number; body?: string | null } | undefined;
    for (let page = 1; !existing; page++) {
      const { data: comments } = await octokit.issues.listComments({
        owner,
        repo,
        issue_number: pullNumber,
        per_page: 100,
        page,
      });
      existing = comments.find((c) => c.body?.includes(WALKTHROUGH_MARKER));
      if (comments.length < 100) break; // last page
    }

    if (existing) {
      await octokit.issues.updateComment({
        owner,
        repo,
        comment_id: existing.id,
        body,
      });
      logger.info({ pullNumber, commentId: existing.id }, 'Walkthrough comment updated');
    } else {
      await octokit.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });
      logger.info({ pullNumber }, 'Walkthrough comment created');
    }
  } catch (err) {
    // Walkthrough comment failure must NOT abort the review
    logger.warn({ err }, 'Failed to post walkthrough comment, continuing');
  }
}

function buildWalkthroughBody(walkthrough: WalkthroughResult, changedFilePaths: string[]): string {
  const lines: string[] = [];

  lines.push('## Kimi Code Review — PR Walkthrough\n');

  if (walkthrough.prSummary) {
    lines.push(walkthrough.prSummary);
    lines.push('');
  }

  const tags = [...walkthrough.detectedLanguages, ...walkthrough.detectedFrameworks];
  if (tags.length > 0) {
    lines.push(tags.map((t) => `\`${t}\``).join(' '));
    lines.push('');
  }

  // Cross-reference against actual changed files to prevent hallucinated paths
  const actualPaths = new Set(changedFilePaths);
  const validWalkthrough = walkthrough.walkthrough.filter((w) => actualPaths.has(w.path));

  if (validWalkthrough.length > 0) {
    lines.push('### Changes Walkthrough\n');
    lines.push('| File | Summary |');
    lines.push('|------|---------|');
    for (const f of validWalkthrough) {
      const icon = { added: '🆕', modified: '✏️', removed: '🗑️', renamed: '🔀' }[f.changeType] ?? '✏️';
      const safeSummary = f.summary.replace(/\|/g, '\\|');
      lines.push(`| ${icon} \`${f.path}\` | ${safeSummary} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('*Powered by [Kimi Code Reviewer](https://github.com/kimi-code-reviewer) — Moonshot AI 256K context*');

  return lines.join('\n');
}
