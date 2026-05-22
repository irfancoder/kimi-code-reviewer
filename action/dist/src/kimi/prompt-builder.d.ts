import type { ChatMessage, PullRequestContext, ChangedFile } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
export declare function detectLanguages(changedFiles: ChangedFile[]): string[];
/**
 * Detect frameworks by scanning file contents for import/require patterns
 * that match the FRAMEWORK_RULES regexes. This replaces the LLM-based detection
 * from the walkthrough pass.
 */
export declare function detectFrameworks(fileContents: Map<string, string>): string[];
export declare function buildDeepReviewMessages(ctx: PullRequestContext, config: ReviewConfig, detectedLanguages: string[], detectedFrameworks: string[], fileContents?: Map<string, string>): ChatMessage[];
//# sourceMappingURL=prompt-builder.d.ts.map