import type { Octokit } from '@octokit/rest';
import type { ReviewConfig } from '../config/schema.js';
import type { ReviewResult } from '../types/review.js';
import { KimiClient } from '../kimi/client.js';
interface ReviewParams {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
}
export declare class ReviewOrchestrator {
    private octokit;
    private kimi;
    private config;
    constructor(octokit: Octokit, kimi: KimiClient, config: ReviewConfig);
    reviewPullRequest(params: ReviewParams): Promise<ReviewResult>;
}
export {};
//# sourceMappingURL=orchestrator.d.ts.map