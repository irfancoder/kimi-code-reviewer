import type { ChatMessage, PullRequestContext, ChangedFile, WalkthroughResult } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
export declare function detectLanguages(changedFiles: ChangedFile[]): string[];
export declare function buildWalkthroughMessages(ctx: PullRequestContext): ChatMessage[];
export declare function buildDeepReviewMessages(ctx: PullRequestContext, config: ReviewConfig, walkthrough: WalkthroughResult, fileContents?: Map<string, string>): ChatMessage[];
//# sourceMappingURL=prompt-builder.d.ts.map