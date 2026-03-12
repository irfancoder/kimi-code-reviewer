import type { Octokit } from '@octokit/rest';
import type { Webhooks } from '@octokit/webhooks';
interface AppContext {
    apiKey: string;
    provider?: string;
    model?: string;
    maxOutputTokens?: number;
    baseUrl?: string;
    getInstallationOctokit: (installationId: number) => Promise<Octokit>;
}
export declare function registerWebhooks(webhooks: Webhooks, appCtx: AppContext): void;
export {};
//# sourceMappingURL=webhooks.d.ts.map