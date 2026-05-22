/**
 * Quick CLI to smoke-test the LLM provider connection.
 * Usage: npm run test:llm
 * Reads the same env vars as the server (API_KEY, MODEL_PROVIDER, MODEL, BASE_URL).
 */
import { createLLMProvider } from '../src/providers/factory.js';

const apiKey =
  process.env.API_KEY ?? process.env.FISCALCR_API_KEY ?? process.env.KIMI_API_KEY;
const provider = process.env.MODEL_PROVIDER ?? 'kimi';
const model =
  process.env.MODEL ?? process.env.FISCALCR_MODEL ?? process.env.KIMI_MODEL ?? 'kimi-k2-0905';
const baseUrl =
  process.env.BASE_URL ?? process.env.FISCALCR_BASE_URL ?? process.env.KIMI_BASE_URL;

if (!apiKey) {
  console.error('Error: set API_KEY (or KIMI_API_KEY / FISCALCR_API_KEY) in your environment.');
  process.exit(1);
}

const llm = createLLMProvider({ apiKey, provider, model, baseUrl });

console.log(`Provider : ${provider}`);
console.log(`Model    : ${model}`);
console.log(`Base URL : ${baseUrl ?? '(default)'}`);
console.log('Sending hello-world request…\n');

const response = await llm.chatCompletion({
  messages: [{ role: 'user', content: 'Say hello world.' }],
  responseFormat: { type: 'text' },
});

console.log('Response:', response.content);
console.log(
  `\nTokens — input: ${response.usage.input}, output: ${response.usage.output}, cached: ${response.usage.cached}`,
);
