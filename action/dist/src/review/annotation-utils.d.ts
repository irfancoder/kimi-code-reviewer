import type { ReviewAnnotation, Severity } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
export declare const SEVERITY_ORDER: Record<Severity, number>;
/**
 * Filters out annotations that match any suppression rule defined in the repo config.
 * Matching is case-insensitive string inclusion against the annotation title + body.
 * When a suppression has a filePattern, it only applies to files matching that glob.
 */
export declare function applySuppressions(annotations: ReviewAnnotation[], suppressions: ReviewConfig['suppressions']): ReviewAnnotation[];
/**
 * Sorts annotations by severity (critical first), then by whether they have a
 * suggestedFix (ones with fixes rank higher within the same severity), then
 * truncates to maxAnnotations. Ensures the most important, most actionable
 * issues are kept when the list is capped.
 */
export declare function sortAndTruncateAnnotations(annotations: ReviewAnnotation[], maxAnnotations: number): ReviewAnnotation[];
//# sourceMappingURL=annotation-utils.d.ts.map