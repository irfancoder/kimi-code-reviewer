import type { ChatMessage, PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
/**
 * Build messages in cache-optimized order for Kimi's prefix caching.
 *
 * Kimi automatically caches message prefixes on the server side.
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
export declare function buildCacheOptimizedMessages(systemPrompt: string, ctx: PullRequestContext, config: ReviewConfig, fileContents: Map<string, string>): ChatMessage[];
//# sourceMappingURL=cache-strategy.d.ts.map