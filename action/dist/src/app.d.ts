import { App } from '@octokit/app';
export interface AppConfig {
    githubAppId: string;
    githubPrivateKey: string;
    githubWebhookSecret: string;
    kimiApiKey: string;
    kimiModel?: string;
}
export declare function createApp(config: AppConfig): App;
//# sourceMappingURL=app.d.ts.map