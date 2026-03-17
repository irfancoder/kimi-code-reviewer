import type { ChatMessage, PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';

/**
 * Build messages in cache-optimized order for prefix caching.
 *
 * The LLM provider automatically caches message prefixes on the server side.
 * Cached tokens cost $0.10/M vs $0.39/M for regular input — 75% savings.
 *
 * Strategy: Place stable content at the beginning of the message array.
 * The more prefix tokens that match between requests, the higher the cache hit rate.
 *
 * Order (most stable → least stable):
 * 1. System prompt (nearly identical across all requests)
 * 2. Repo config + custom rules (fixed per repo)
 * 3. Base file contents (stable within same PR, across pushes)
 * 4. PR description (occasionally edited)
 * 5. Diff content (changes every push — always last)
 */
export function buildCacheOptimizedMessages(
  systemPrompt: string,
  ctx: PullRequestContext,
  config: ReviewConfig,
  fileContents: Map<string, string>,
): ChatMessage[] {
  const messages: ChatMessage[] = [];

  // Layer 1: System prompt (most stable)
  messages.push({ role: 'system', content: systemPrompt });

  // Layer 2: Repo config acknowledgment
  const configSummary = buildConfigSummary(config);
  if (configSummary) {
    messages.push({ role: 'user', content: `Repository review configuration:\n${configSummary}` });
    messages.push({ role: 'assistant', content: 'Understood. I will follow the repository configuration.' });
  }

  // Layer 3: Base file contents (stable across pushes to same PR)
  if (fileContents.size > 0) {
    const fileParts: string[] = ['Here are the relevant source files for context:'];
    for (const [path, content] of fileContents) {
      fileParts.push(`\n### ${path}\n\`\`\`\n${content}\n\`\`\``);
    }
    messages.push({ role: 'user', content: fileParts.join('\n') });
    messages.push({ role: 'assistant', content: 'Files loaded. Send me the pull request diff to review.' });
  }

  // Layer 4+5: PR metadata + diff (least stable)
  const reviewRequest: string[] = [];
  reviewRequest.push(`## Pull Request #${ctx.pullNumber}: ${ctx.title}`);
  if (ctx.body) {
    reviewRequest.push(`\n### Description\n${ctx.body}`);
  }
  reviewRequest.push(`\n### Changed Files (${ctx.changedFiles.length} files)`);
  for (const file of ctx.changedFiles) {
    reviewRequest.push(`- ${file.filename} (+${file.additions}/-${file.deletions})`);
  }
  reviewRequest.push(`\n### Diff\n\`\`\`diff\n${ctx.diff}\n\`\`\``);
  reviewRequest.push('\nPlease review and respond with JSON.');

  messages.push({ role: 'user', content: reviewRequest.join('\n') });

  return messages;
}

function buildConfigSummary(config: ReviewConfig): string {
  const parts: string[] = [];

  parts.push(`Language: ${config.language}`);
  parts.push(`Minimum severity: ${config.review.minSeverity}`);
  parts.push(`Fail on: ${config.review.failOn}`);

  const aspects = Object.entries(config.review.aspects)
    .filter(([, v]) => v)
    .map(([k]) => k);
  parts.push(`Review aspects: ${aspects.join(', ')}`);

  if (config.rules.length > 0) {
    parts.push('\nCustom rules:');
    for (const rule of config.rules) {
      parts.push(`- [${rule.severity}] ${rule.name}: ${rule.description}`);
    }
  }

  if (config.prompt.reviewFocus) {
    parts.push(`\nReview focus: ${config.prompt.reviewFocus}`);
  }

  return parts.join('\n');
}
