import type { ReviewResult } from '../types/review.js';
export declare function parseAIResponse(raw: string, tokenUsage: {
    input: number;
    output: number;
    cached: number;
}): ReviewResult;
//# sourceMappingURL=response-parser.d.ts.map