import type { ReviewResult, Severity } from '../types/review.js';
import { calculateCost } from '../utils/tokens.js';

const SEVERITY_EMOJI: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  suggestion: '🔵',
  nitpick: '⚪',
};

/**
 * Build a markdown summary for the Check Run output.
 */
export function buildSummary(result: ReviewResult): string {
  const cost = calculateCost(result.tokensUsed);
  const lines: string[] = [];

  lines.push(`## Score: ${result.score}/100\n`);
  lines.push(result.summary);
  lines.push('');

  // Stats table
  const hasIssues = Object.values(result.stats).some((v) => v > 0);
  if (hasIssues) {
    lines.push('### Findings\n');
    lines.push('| Severity | Count |');
    lines.push('|----------|-------|');
    for (const severity of ['critical', 'warning', 'suggestion', 'nitpick'] as Severity[]) {
      const count = result.stats[severity];
      if (count > 0) {
        lines.push(`| ${SEVERITY_EMOJI[severity]} ${severity} | ${count} |`);
      }
    }
    lines.push('');
  } else {
    lines.push('### ✅ No issues found\n');
  }

  // Token usage
  lines.push('<details>');
  lines.push('<summary>📊 Token Usage</summary>\n');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Input tokens | ${result.tokensUsed.input.toLocaleString()} |`);
  lines.push(`| Output tokens | ${result.tokensUsed.output.toLocaleString()} |`);
  lines.push(`| Cached tokens | ${result.tokensUsed.cached.toLocaleString()} |`);
  lines.push(`| Estimated cost | $${cost} |`);
  lines.push('</details>');

  return lines.join('\n');
}
