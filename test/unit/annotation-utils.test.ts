import { describe, it, expect } from 'vitest';
import { applySuppressions, sortAndTruncateAnnotations } from '../../src/review/annotation-utils.js';
import type { ReviewAnnotation } from '../../src/types/review.js';

function makeAnnotation(overrides: Partial<ReviewAnnotation>): ReviewAnnotation {
  return {
    path: 'src/index.ts',
    startLine: 1,
    endLine: 1,
    severity: 'warning',
    category: 'bug',
    title: 'Some issue',
    body: 'Some body text',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// applySuppressions
// ---------------------------------------------------------------------------

describe('applySuppressions', () => {
  it('returns all annotations when suppressions is empty', () => {
    const annotations = [makeAnnotation({ title: 'console.log usage' })];
    expect(applySuppressions(annotations, [])).toHaveLength(1);
  });

  it('suppresses annotation whose title matches the pattern', () => {
    const annotations = [
      makeAnnotation({ title: 'console.log usage detected' }),
      makeAnnotation({ title: 'Missing null check' }),
    ];
    const result = applySuppressions(annotations, [{ pattern: 'console.log' }]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Missing null check');
  });

  it('matches pattern in body as well as title', () => {
    const annotations = [
      makeAnnotation({ title: 'Style issue', body: 'You should add JSDoc documentation here.' }),
    ];
    const result = applySuppressions(annotations, [{ pattern: 'JSDoc' }]);
    expect(result).toHaveLength(0);
  });

  it('is case-insensitive', () => {
    const annotations = [makeAnnotation({ title: 'CONSOLE.LOG detected' })];
    const result = applySuppressions(annotations, [{ pattern: 'console.log' }]);
    expect(result).toHaveLength(0);
  });

  it('only suppresses in matching files when filePattern is set', () => {
    const annotations = [
      makeAnnotation({ path: 'src/index.ts', title: 'Missing JSDoc' }),
      makeAnnotation({ path: 'src/index.test.ts', title: 'Missing JSDoc' }),
    ];
    const result = applySuppressions(annotations, [
      { pattern: 'Missing JSDoc', filePattern: '**/*.test.ts' },
    ]);
    // Only the test file annotation should be suppressed
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('src/index.ts');
  });

  it('does not suppress when pattern does not match', () => {
    const annotations = [makeAnnotation({ title: 'Null pointer risk' })];
    const result = applySuppressions(annotations, [{ pattern: 'console.log' }]);
    expect(result).toHaveLength(1);
  });

  it('handles multiple suppressions', () => {
    const annotations = [
      makeAnnotation({ title: 'console.log usage' }),
      makeAnnotation({ title: 'Missing JSDoc' }),
      makeAnnotation({ title: 'Null pointer risk' }),
    ];
    const result = applySuppressions(annotations, [
      { pattern: 'console.log' },
      { pattern: 'JSDoc' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Null pointer risk');
  });
});

// ---------------------------------------------------------------------------
// sortAndTruncateAnnotations
// ---------------------------------------------------------------------------

describe('sortAndTruncateAnnotations', () => {
  it('sorts critical before warning before suggestion before nitpick', () => {
    const annotations = [
      makeAnnotation({ severity: 'nitpick', title: 'Nitpick' }),
      makeAnnotation({ severity: 'critical', title: 'Critical' }),
      makeAnnotation({ severity: 'suggestion', title: 'Suggestion' }),
      makeAnnotation({ severity: 'warning', title: 'Warning' }),
    ];
    const result = sortAndTruncateAnnotations(annotations, 10);
    expect(result.map((a) => a.severity)).toEqual(['critical', 'warning', 'suggestion', 'nitpick']);
  });

  it('within same severity, annotations with suggestedFix rank first', () => {
    const annotations = [
      makeAnnotation({ severity: 'warning', title: 'No fix', suggestedFix: undefined }),
      makeAnnotation({ severity: 'warning', title: 'Has fix', suggestedFix: 'const x = 1;' }),
    ];
    const result = sortAndTruncateAnnotations(annotations, 10);
    expect(result[0].title).toBe('Has fix');
    expect(result[1].title).toBe('No fix');
  });

  it('treats empty-string suggestedFix the same as no fix when sorting', () => {
    const annotations = [
      makeAnnotation({ severity: 'warning', title: 'Empty fix', suggestedFix: '' }),
      makeAnnotation({ severity: 'warning', title: 'Real fix', suggestedFix: 'const x = 1;' }),
    ];
    const result = sortAndTruncateAnnotations(annotations, 10);
    // empty string is falsy so it should rank the same as no fix
    expect(result[0].title).toBe('Real fix');
  });

  it('truncates to maxAnnotations after sorting', () => {
    const annotations = [
      makeAnnotation({ severity: 'nitpick', title: 'Nitpick 1' }),
      makeAnnotation({ severity: 'nitpick', title: 'Nitpick 2' }),
      makeAnnotation({ severity: 'critical', title: 'Critical' }),
    ];
    const result = sortAndTruncateAnnotations(annotations, 2);
    expect(result).toHaveLength(2);
    // Critical should survive the truncation
    expect(result[0].title).toBe('Critical');
    expect(result[1].severity).toBe('nitpick');
  });

  it('returns empty array for empty input', () => {
    expect(sortAndTruncateAnnotations([], 10)).toHaveLength(0);
  });

  it('does not mutate the input array', () => {
    const annotations = [
      makeAnnotation({ severity: 'warning' }),
      makeAnnotation({ severity: 'critical' }),
    ];
    const original = [...annotations];
    sortAndTruncateAnnotations(annotations, 10);
    expect(annotations[0].severity).toBe(original[0].severity);
    expect(annotations[1].severity).toBe(original[1].severity);
  });
});
