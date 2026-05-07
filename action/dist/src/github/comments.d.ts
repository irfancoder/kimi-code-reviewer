import type { Octokit } from "@octokit/rest";
import type { ReviewResult, WalkthroughResult } from "../types/review.js";
export declare function createPRReview(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    commitSha: string;
    result: ReviewResult;
    failOn: "critical" | "warning" | "never";
    provider?: string;
    model?: string;
    baseUrl?: string;
}): Promise<void>;
export declare function createWalkthroughComment(octokit: Octokit, params: {
    owner: string;
    repo: string;
    pullNumber: number;
    headSha: string;
    walkthrough: WalkthroughResult;
    changedFilePaths: string[];
}): Promise<void>;
//# sourceMappingURL=comments.d.ts.map