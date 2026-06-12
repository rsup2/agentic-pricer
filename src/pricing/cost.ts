import type { TokenUsage } from './types.js';

/**
 * Token -> USD pricing. Per-million-token rates (June 2026).
 * Cache reads priced at the standard ~0.1x input approximation; confirm against
 * https://platform.claude.com/docs/en/pricing for billing-grade precision.
 */
type Rate = { inputPerMTok: number; outputPerMTok: number; cacheReadPerMTok: number };

const PRICING: Record<string, Rate> = {
  'anthropic/claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, cacheReadPerMTok: 0.5 },
  'anthropic/claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3 },
  'anthropic/claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheReadPerMTok: 0.1 },
};

const FALLBACK: Rate = PRICING['anthropic/claude-opus-4-8'];

export function estimateCostUsd(modelId: string, usage: TokenUsage): number {
  const rate = PRICING[modelId] ?? FALLBACK;
  const cost =
    (usage.inputTokens / 1_000_000) * rate.inputPerMTok +
    (usage.outputTokens / 1_000_000) * rate.outputPerMTok +
    (usage.cacheReadTokens / 1_000_000) * rate.cacheReadPerMTok;
  // round to 6dp to match the NUMBER(12,6) column
  return Math.round(cost * 1_000_000) / 1_000_000;
}

/** Roll up usage across multiple LLM-call results into one TokenUsage. */
export function sumUsage(usages: Array<Partial<TokenUsage>>): TokenUsage {
  return usages.reduce<TokenUsage>(
    (acc, u) => ({
      inputTokens: acc.inputTokens + (u.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (u.outputTokens ?? 0),
      cacheReadTokens: acc.cacheReadTokens + (u.cacheReadTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  );
}

/**
 * Normalize a Mastra/AI-SDK usage object (field names vary across versions) into
 * our TokenUsage. Handles both v5 names (inputTokens/outputTokens/cachedInputTokens)
 * and legacy v4 names (promptTokens/completionTokens).
 */
export function normalizeUsage(usage: Record<string, unknown> | undefined | null): TokenUsage {
  const u = (usage ?? {}) as Record<string, number | undefined>;
  return {
    inputTokens: u.inputTokens ?? u.promptTokens ?? 0,
    outputTokens: u.outputTokens ?? u.completionTokens ?? 0,
    cacheReadTokens: u.cachedInputTokens ?? u.cacheReadInputTokens ?? 0,
  };
}
