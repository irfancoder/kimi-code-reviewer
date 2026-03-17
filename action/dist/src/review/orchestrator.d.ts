import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ReviewResult } from '../types/review.js';
import type { LLMProvider } from '../providers/interface.js';
interface ReviewParams {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
}
export declare class ReviewOrchestrator {
    private octokit;
    private llm;
    private config;
    constructor(octokit: Octokit, llm: LLMProvider, config: ReviewConfig);
    reviewPullRequest(params: ReviewParams): Promise<ReviewResult>;
}
export {};
//# sourceMappingURL=orchestrator.d.ts.map