import type { PullRequestContext, ChangedFile, PackResult, ChatMessage } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { estimateTokens } from '../utils/tokens.js';
import { logger } from '../utils/logger.js';

const MAX_CONTEXT_TOKENS = 256_000;
const SYSTEM_PROMPT_RESERVE = 4_000;
const OUTPUT_RESERVE = 16_384;
const BUDGET = MAX_CONTEXT_TOKENS - SYSTEM_PROMPT_RESERVE - OUTPUT_RESERVE; // ~235K

const FULL_MODE_THRESHOLD = 50_000;
const MIXED_MODE_THRESHOLD = 150_000;

export function packContext(
  ctx: PullRequestContext,
  config: ReviewConfig,
): PackResult {
  const diffTokens = estimateTokens(ctx.diff);
  logger.info({ diffTokens, filesCount: ctx.changedFiles.length }, 'Packing context');

  if (diffTokens < FULL_MODE_THRESHOLD) {
    return packFull(ctx, config);
  }
  if (diffTokens < MIXED_MODE_THRESHOLD) {
    return packMixed(ctx, config);
  }
  return packChunked(ctx, config);
}

/** Full mode: include all file contents + diff */
function packFull(ctx: PullRequestContext, _config: ReviewConfig): PackResult {
  const includedFiles: string[] = [];
  const messages: ChatMessage[] = [];
  let totalTokens = 0;

  // Add file contents
  for (const file of ctx.changedFiles) {
    const content = ctx.fileContents.get(file.filename);
    if (content) {
      const tokens = estimateTokens(content);
      if (totalTokens + tokens < BUDGET * 0.6) {
        includedFiles.push(file.filename);
        totalTokens += tokens;
      }
    }
  }

  // Build the user message with file contents + diff
  const parts: string[] = [];
  parts.push(`## Pull Request: ${ctx.title}\n`);
  if (ctx.body) parts.push(`### Description\n${ctx.body}\n`);

  if (includedFiles.length > 0) {
    parts.push('### File Contents (full context)\n');
    for (const path of includedFiles) {
      const content = ctx.fileContents.get(path)!;
      parts.push(`#### ${path}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  parts.push(`### Diff\n\`\`\`diff\n${ctx.diff}\n\`\`\`\n`);

  messages.push({ role: 'user', content: parts.join('\n') });
  totalTokens += estimateTokens(ctx.diff);

  return {
    messages,
    totalTokens,
    includedFiles,
    truncatedFiles: [],
    strategy: 'full',
  };
}

/** Mixed mode: critical files get full content, rest get diff only */
function packMixed(ctx: PullRequestContext, _config: ReviewConfig): PackResult {
  const includedFiles: string[] = [];
  const truncatedFiles: string[] = [];
  let totalTokens = 0;

  // Prioritize files by change size (more changes = more important for context)
  const sorted = [...ctx.changedFiles].sort(
    (a, b) => (b.additions + b.deletions) - (a.additions + a.deletions),
  );

  for (const file of sorted) {
    const content = ctx.fileContents.get(file.filename);
    if (content) {
      const tokens = estimateTokens(content);
      if (totalTokens + tokens < BUDGET * 0.4) {
        includedFiles.push(file.filename);
        totalTokens += tokens;
      } else {
        truncatedFiles.push(file.filename);
      }
    }
  }

  const parts: string[] = [];
  parts.push(`## Pull Request: ${ctx.title}\n`);
  if (ctx.body) parts.push(`### Description\n${ctx.body}\n`);

  if (includedFiles.length > 0) {
    parts.push('### Key File Contents\n');
    for (const path of includedFiles) {
      const content = ctx.fileContents.get(path)!;
      parts.push(`#### ${path}\n\`\`\`\n${content}\n\`\`\`\n`);
    }
  }

  parts.push(`### Diff\n\`\`\`diff\n${ctx.diff}\n\`\`\`\n`);
  totalTokens += estimateTokens(ctx.diff);

  return {
    messages: [{ role: 'user', content: parts.join('\n') }],
    totalTokens,
    includedFiles,
    truncatedFiles,
    strategy: 'mixed',
  };
}

/** Chunked mode: split by files into multiple reviews */
function packChunked(ctx: PullRequestContext, _config: ReviewConfig): PackResult {
  // For chunked mode, just send the diff without file contents
  // The orchestrator will handle splitting into multiple API calls
  const parts: string[] = [];
  parts.push(`## Pull Request: ${ctx.title}\n`);
  if (ctx.body) parts.push(`### Description\n${ctx.body}\n`);
  parts.push(`### Diff\n\`\`\`diff\n${ctx.diff}\n\`\`\`\n`);

  const totalTokens = estimateTokens(ctx.diff);

  return {
    messages: [{ role: 'user', content: parts.join('\n') }],
    totalTokens,
    includedFiles: [],
    truncatedFiles: ctx.changedFiles.map((f) => f.filename),
    strategy: 'chunked',
  };
}
