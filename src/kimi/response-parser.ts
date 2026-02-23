import { z } from 'zod';
import type { ReviewResult, Severity, AnnotationCategory } from '../types/review.js';
import { logger } from '../utils/logger.js';

const annotationSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  severity: z.enum(['critical', 'warning', 'suggestion', 'nitpick']),
  category: z.enum([
    'bug', 'security', 'performance', 'style',
    'best-practice', 'documentation', 'testing', 'other',
  ]),
  title: z.string(),
  body: z.string(),
  suggestedFix: z.string().nullable().optional(),
});

const reviewResponseSchema = z.object({
  summary: z.string(),
  score: z.number().min(0).max(100),
  annotations: z.array(annotationSchema),
});

export function parseKimiResponse(
  raw: string,
  tokenUsage: { input: number; output: number; cached: number },
): ReviewResult {
  let parsed: unknown;

  // Try direct JSON parse
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fallback: extract JSON from markdown code block
    const match = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (match) {
      try {
        parsed = JSON.parse(match[1]);
      } catch {
        logger.error('Failed to parse JSON from code block');
      }
    }
  }

  if (!parsed) {
    // Last resort: return a minimal result
    return {
      summary: 'Failed to parse Kimi response. Raw output was received but could not be structured.',
      score: 50,
      annotations: [],
      stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
      tokensUsed: tokenUsage,
    };
  }

  const result = reviewResponseSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn({ errors: result.error.issues }, 'Kimi response schema validation failed');
    // Try to salvage what we can
    const partial = parsed as Record<string, unknown>;
    return {
      summary: typeof partial.summary === 'string' ? partial.summary : 'Review completed (partial parse)',
      score: typeof partial.score === 'number' ? partial.score : 50,
      annotations: [],
      stats: { critical: 0, warning: 0, suggestion: 0, nitpick: 0 },
      tokensUsed: tokenUsage,
    };
  }

  const data = result.data;
  const stats: Record<Severity, number> = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
  for (const annotation of data.annotations) {
    stats[annotation.severity]++;
  }

  return {
    summary: data.summary,
    score: data.score,
    annotations: data.annotations.map((a) => ({
      ...a,
      category: a.category as AnnotationCategory,
      suggestedFix: a.suggestedFix ?? undefined,
    })),
    stats,
    tokensUsed: tokenUsage,
  };
}
