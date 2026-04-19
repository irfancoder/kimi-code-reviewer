import { minimatch } from 'minimatch';
import type { ReviewAnnotation, Severity } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
import { logger } from '../utils/logger.js';

export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  suggestion: 2,
  nitpick: 3,
};

/**
 * Filters out annotations that match any suppression rule defined in the repo config.
 * Matching is case-insensitive string inclusion against the annotation title + body.
 * When a suppression has a filePattern, it only applies to files matching that glob.
 */
export function applySuppressions(
  annotations: ReviewAnnotation[],
  suppressions: ReviewConfig['suppressions'],
): ReviewAnnotation[] {
  if (!suppressions || suppressions.length === 0) return annotations;

  return annotations.filter((annotation) => {
    const haystack = `${annotation.title} ${annotation.body}`.toLowerCase();
    for (const suppression of suppressions) {
      if (!haystack.includes(suppression.pattern.toLowerCase())) continue;

      if (suppression.filePattern) {
        if (!minimatch(annotation.path, suppression.filePattern)) continue;
      }

      logger.debug(
        { path: annotation.path, title: annotation.title, pattern: suppression.pattern },
        'Annotation suppressed by config rule',
      );
      return false;
    }
    return true;
  });
}

/**
 * Sorts annotations by severity (critical first), then by whether they have a
 * suggestedFix (ones with fixes rank higher within the same severity), then
 * truncates to maxAnnotations. Ensures the most important, most actionable
 * issues are kept when the list is capped.
 */
export function sortAndTruncateAnnotations(
  annotations: ReviewAnnotation[],
  maxAnnotations: number,
): ReviewAnnotation[] {
  const sorted = [...annotations].sort((a, b) => {
    const severityDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (severityDiff !== 0) return severityDiff;
    const aHasFix = a.suggestedFix ? 0 : 1;
    const bHasFix = b.suggestedFix ? 0 : 1;
    return aHasFix - bHasFix;
  });

  return sorted.slice(0, maxAnnotations);
}
