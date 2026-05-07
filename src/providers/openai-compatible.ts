import { Agent } from "undici";
import type { ChatMessage } from "../types/review.js";
import { ConfigError, LLMApiError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { estimateTokens } from "../utils/tokens.js";
import type { LLMCompletionResponse, LLMProvider } from "./interface.js";

export interface OpenAICompatibleProviderConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  timeout?: number;
}

interface OpenAICompatibleResponse {
  choices: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
      reasoning?: string;
      refusal?: string;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cached_tokens?: number;
  };
}

/**
 * Generic provider for OpenAI-compatible chat completion APIs.
 * Works with any OpenAI-compatible endpoint (FiscalCR, OpenAI, Groq, self-hosted, etc.).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly temperature: number;
  private readonly timeout: number;
  private readonly isOpenRouter: boolean;

  constructor(config: OpenAICompatibleProviderConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    if (!config.baseUrl) {
      throw new ConfigError(
        "OpenAI-compatible provider requires an explicit baseUrl",
      );
    }
    this.baseUrl = config.baseUrl;
    this.temperature = config.temperature ?? 0.2;
    this.timeout = config.timeout ?? 600_000;
    this.isOpenRouter = this.baseUrl.toLowerCase().includes("openrouter.ai");
  }

  async chatCompletion(params: {
    messages: ChatMessage[];
    responseFormat?: { type: "json_object" | "text" };
  }): Promise<LLMCompletionResponse> {
    const response = await this.withTimeout((signal) =>
      this.performCompletionRequest(params.messages, params.responseFormat, signal),
    );

    if (
      this.isOpenRouter &&
      params.responseFormat?.type === "json_object" &&
      !response.content.trim()
    ) {
      logger.warn(
        { model: this.model, baseUrl: this.baseUrl },
        "OpenRouter returned empty structured output, retrying without response_format",
      );

      const retryResponse = await this.withTimeout((signal) =>
        this.performCompletionRequest(params.messages, undefined, signal),
      );

      return retryResponse.content.trim() ? retryResponse : response;
    }

    return response;
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await fn(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private extractTextContent(
    message: OpenAICompatibleResponse["choices"][number]["message"] | undefined,
  ): string {
    const content = message?.content;

    if (typeof content === "string") {
      return content;
    }

    if (Array.isArray(content)) {
      return content
        .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
        .join("")
        .trim();
    }

    return message?.reasoning ?? message?.refusal ?? "";
  }

  private async performCompletionRequest(
    messages: ChatMessage[],
    responseFormat: { type: "json_object" | "text" } | undefined,
    signal: AbortSignal,
  ): Promise<LLMCompletionResponse> {
    const isOpenRouter = this.isOpenRouter;
    const body = {
      model: this.model,
      messages,
      temperature: this.temperature,
      ...(responseFormat && { response_format: responseFormat }),
      ...(isOpenRouter && responseFormat
        ? { plugins: [{ id: "response-healing" }] }
        : {}),
    };

    const dispatcher = new Agent({
      headersTimeout: this.timeout,
      bodyTimeout: this.timeout,
    });

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        // 'User-Agent': 'fiscalcr/1.0',
        // 'X-Client-Name': 'fiscalcr',
        // NOTE: this is needed for own usage to bypass kimi 403
        "User-Agent": "claude-code/1.0",
        "X-Client-Name": "claude-code",
      },
      body: JSON.stringify(body),
      signal,
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

    const data = (await res.json()) as OpenAICompatibleResponse;
    const firstChoice = data.choices?.[0];
    const content = this.extractTextContent(firstChoice?.message);

    const usage = {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
      cached: data.usage?.cached_tokens ?? 0,
    };

    logger.info(
      {
        model: this.model,
        baseUrl: this.baseUrl,
        promptTokens: usage.input,
        completionTokens: usage.output,
        cachedTokens: usage.cached,
        finishReason: firstChoice?.finish_reason ?? null,
      },
      "LLM API call completed",
    );

    return { content, usage };
  }
}
