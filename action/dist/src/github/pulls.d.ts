import type { Octokit } from '@octokit/rest';
import type { PullRequestContext } from '../types/review.js';
import type { ReviewConfig } from '../config/schema.js';
export declare function extractPullRequestContext(octokit: Octokit, owner: string, repo: string, pullNumber: number, config: ReviewConfig): Promise<PullRequestContext>;
//# sourceMappingURL=pulls.d.ts.map