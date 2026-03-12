import type { LLMProvider } from './interface.js';
export declare const SUPPORTED_PROVIDERS: readonly ["kimi", "openai-compatible"];
export declare function createLLMProvider(config: {
    apiKey: string;
    model: string;
    baseUrl?: string;
    provider: string;
}): LLMProvider;
//# sourceMappingURL=factory.d.ts.map