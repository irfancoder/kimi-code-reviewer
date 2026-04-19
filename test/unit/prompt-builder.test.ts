import { describe, it, expect } from 'vitest';
import { detectLanguages } from '../../src/kimi/prompt-builder.js';
import type { ChangedFile } from '../../src/types/review.js';

function makeFile(filename: string): ChangedFile {
  return { filename, status: 'modified', additions: 5, deletions: 2 };
}

describe('detectLanguages', () => {
  it('detects TypeScript from .ts files', () => {
    const result = detectLanguages([makeFile('src/index.ts')]);
    expect(result).toContain('TypeScript');
  });

  it('detects TypeScript from .tsx files', () => {
    const result = detectLanguages([makeFile('src/App.tsx')]);
    expect(result).toContain('TypeScript');
  });

  it('detects Python from .py files', () => {
    const result = detectLanguages([makeFile('main.py')]);
    expect(result).toContain('Python');
  });

  it('detects Go from .go files', () => {
    const result = detectLanguages([makeFile('main.go')]);
    expect(result).toContain('Go');
  });

  it('detects multiple languages in a mixed PR', () => {
    const files = [
      makeFile('backend/main.go'),
      makeFile('frontend/App.tsx'),
      makeFile('scripts/deploy.sh'),
    ];
    const result = detectLanguages(files);
    expect(result).toContain('Go');
    expect(result).toContain('TypeScript');
    expect(result).toContain('Shell');
  });

  it('deduplicates the same language across multiple files', () => {
    const files = [makeFile('a.ts'), makeFile('b.ts'), makeFile('c.ts')];
    const result = detectLanguages(files);
    expect(result.filter((l) => l === 'TypeScript')).toHaveLength(1);
  });

  it('ignores files with unknown extensions', () => {
    const result = detectLanguages([makeFile('Makefile'), makeFile('Dockerfile')]);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(detectLanguages([])).toHaveLength(0);
  });
});
