import type { ReviewResult, WalkthroughResult } from '../types/review.js';
export declare function parseAIResponse(raw: string, tokenUsage: {
    input: number;
    output: number;
    cached: number;
}): ReviewResult;
export declare function parseWalkthroughResponse(raw: string, tokenUsage: {
    input: number;
    output: number;
    cached: number;
}): WalkthroughResult;
//# sourceMappingURL=response-parser.d.ts.map