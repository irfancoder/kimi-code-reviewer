import type { ChatMessage } from "../types/review.js";
export interface AIClientConfig {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    temperature?: number;
    timeout?: number;
}
export interface ChatCompletionResponse {
    id: string;
    choices: Array<{
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }>;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        cached_tokens?: number;
    };
}
export declare class AIClient {
    private baseUrl;
    private apiKey;
    private model;
    private temperature;
    private timeout;
    constructor(config: AIClientConfig);
    chatCompletion(params: {
        messages: ChatMessage[];
        responseFormat?: {
            type: "json_object" | "text";
        };
    }): Promise<ChatCompletionResponse>;
}
//# sourceMappingURL=client.d.ts.map