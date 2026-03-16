import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';

describe('OpenAICompatibleProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not send an explicit max_tokens cap', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"summary":"ok","score":100,"annotations":[]}' } }],
            usage: { prompt_tokens: 1000, completion_tokens: 200, cached_tokens: 0 },
          }),
          { status: 200, statusText: 'OK' },
        ),
      );

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      model: 'Qwen/Qwen2.5-3B-Instruct',
      baseUrl: 'https://chat.alifaiman.cloud/v1',
    });

    const result = await provider.chatCompletion({
      messages: [
        { role: 'system', content: 'You are a code reviewer.' },
        {
          role: 'user',
          content: 'Please review this diff and respond in JSON. '.repeat(40),
        },
      ],
      responseFormat: { type: 'json_object' },
    });

    expect(result.content).toContain('summary');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));

    expect(body.max_tokens).toBeUndefined();
  });
});
