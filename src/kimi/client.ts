import { Agent } from "undici";
import type { ChatMessage } from "../types/review.js";
import { LLMApiError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

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
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cached_tokens?: number;
  };
}

export class AIClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private temperature: number;
  private timeout: number;

  constructor(config: AIClientConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? "kimi-k2.5";
    this.baseUrl = config.baseUrl ?? "https://api.kimi.com/coding/v1";
    this.temperature = config.temperature ?? 1;
    this.timeout = config.timeout ?? 300_000;
  }

  async chatCompletion(params: {
    messages: ChatMessage[];
    responseFormat?: { type: "json_object" | "text" };
  }): Promise<ChatCompletionResponse> {
    const body = {
      model: this.model,
      messages: params.messages,
      temperature: this.temperature,
      ...(params.responseFormat && { response_format: params.responseFormat }),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const dispatcher = new Agent({
        headersTimeout: this.timeout,
        bodyTimeout: this.timeout,
      });

      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "User-Agent": "claude-code/1.0",
          "X-Client-Name": "claude-code",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        dispatcher,
      } as unknown as RequestInit);

      if (!res.ok) {
        const errorBody = await res.text().catch(() => "");
        throw new LLMApiError(
          `LLM API error: ${res.status} ${res.statusText}`,
          res.status,
          errorBody,
        );
      }

      const data = (await res.json()) as ChatCompletionResponse;

      logger.info(
        {
          model: this.model,
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          cachedTokens: data.usage.cached_tokens ?? 0,
        },
        "LLM API call completed",
      );

      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}
