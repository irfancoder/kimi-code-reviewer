import { describe, it, expect } from 'vitest';
import { parseWalkthroughResponse } from '../../src/kimi/response-parser.js';

const usage = { input: 500, output: 200, cached: 0 };

describe('parseWalkthroughResponse', () => {
  it('parses a valid walkthrough response', () => {
    const raw = JSON.stringify({
      prSummary: 'This PR adds a two-pass review system.',
      walkthrough: [
        { path: 'src/orchestrator.ts', summary: 'Refactored to run two API calls.', changeType: 'modified' },
      ],
      detectedLanguages: ['TypeScript'],
      detectedFrameworks: ['Node.js'],
    });

    const result = parseWalkthroughResponse(raw, usage);
    expect(result.prSummary).toBe('This PR adds a two-pass review system.');
    expect(result.walkthrough).toHaveLength(1);
    expect(result.walkthrough[0].path).toBe('src/orchestrator.ts');
    expect(result.walkthrough[0].changeType).toBe('modified');
    expect(result.detectedLanguages).toContain('TypeScript');
    expect(result.detectedFrameworks).toContain('Node.js');
    expect(result.tokensUsed).toEqual(usage);
  });

  it('defaults changeType to modified when the value is unrecognised', () => {
    const raw = JSON.stringify({
      prSummary: 'PR summary.',
      walkthrough: [{ path: 'src/foo.ts', summary: 'Changed.', changeType: 'unknown_value' }],
      detectedLanguages: [],
      detectedFrameworks: [],
    });
    const result = parseWalkthroughResponse(raw, usage);
    expect(result.walkthrough[0].changeType).toBe('modified');
  });

  it('returns a safe empty result when the response is not valid JSON', () => {
    const result = parseWalkthroughResponse('I cannot summarize this.', usage);
    expect(result.prSummary).toBe('');
    expect(result.walkthrough).toHaveLength(0);
    expect(result.detectedLanguages).toHaveLength(0);
    expect(result.tokensUsed).toEqual(usage);
  });

  it('salvages detectedLanguages from a partially valid response', () => {
    // walkthrough array contains invalid items but languages are present
    const raw = JSON.stringify({
      prSummary: 'Summary.',
      walkthrough: 'not an array',       // invalid — should be array
      detectedLanguages: ['Go', 'Python'],
      detectedFrameworks: [],
    });
    const result = parseWalkthroughResponse(raw, usage);
    expect(result.detectedLanguages).toContain('Go');
    expect(result.detectedLanguages).toContain('Python');
  });

  it('returns empty arrays for missing optional fields', () => {
    const raw = JSON.stringify({ prSummary: 'Summary only.' });
    const result = parseWalkthroughResponse(raw, usage);
    expect(result.walkthrough).toHaveLength(0);
    expect(result.detectedLanguages).toHaveLength(0);
    expect(result.detectedFrameworks).toHaveLength(0);
  });

  it('parses walkthrough from a markdown-wrapped JSON response', () => {
    const raw = `Here is the walkthrough:\n\`\`\`json\n${JSON.stringify({
      prSummary: 'Markdown wrapped.',
      walkthrough: [],
      detectedLanguages: ['Rust'],
      detectedFrameworks: [],
    })}\n\`\`\``;
    const result = parseWalkthroughResponse(raw, usage);
    expect(result.prSummary).toBe('Markdown wrapped.');
    expect(result.detectedLanguages).toContain('Rust');
  });
});
