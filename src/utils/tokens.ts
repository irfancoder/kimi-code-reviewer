/**
 * Rough token estimation. ~4 chars per token for English,
 * ~2 chars per token for CJK. Good enough for context budget planning.
 */
export function estimateTokens(text: string): number {
  // Count CJK characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(nonCjkLength / 4 + cjkCount / 2);
}

/**
 * Calculate API cost in USD based on token usage.
 */
export function calculateCost(usage: {
  input: number;
  output: number;
  cached: number;
}): number {
  const inputCost = (usage.input / 1_000_000) * 0.39;
  const outputCost = (usage.output / 1_000_000) * 1.9;
  const cachedCost = (usage.cached / 1_000_000) * 0.1;
  return Math.round((inputCost + outputCost + cachedCost) * 10000) / 10000;
}
