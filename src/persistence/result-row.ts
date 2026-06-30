import { createHash } from 'node:crypto';
import { estimateCostUsd } from '../pricing/cost.js';
import type { PricingRequestDto, SamplingMeta } from '../pricing/types.js';
import type { PricingRunResult } from '../pricing/run.js';
import { toYmd } from '../pricing/gather.js';

/** One DB row per (request x SRT). Run-level fields repeat across a run's rows. */
export type ResultRow = {
  requestId: string;
  runId: string | null;
  hrtId: number | null;
  srtId: number | null;
  estimatedPatientResp: number | null;
  benefitType: string | null;
  confidence: string;
  reasoning: string;
  sourceBreakdown: unknown;
  warnings: unknown;
  totalLatencyMs: number | null;
  stepLatencyMs: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  estimatedCostUsd: number | null;
  modelId: string | null;
  pricingDate: string | null; // YYYY-MM-DD
  dtoDigest: string;
  status: 'COMPLETED' | 'ERROR';
  errorMessage: string | null;
  // sampling provenance (from AIR's shadow sampler; null on manual/direct calls)
  samplingStratum: string | null;
  inclusionProbability: number | null;
  samplingReason: string | null;
  airRequestType: string | null;
};

/** Flatten optional sampling metadata to the four nullable row columns. */
function samplingCols(sampling?: SamplingMeta): Pick<
  ResultRow,
  'samplingStratum' | 'inclusionProbability' | 'samplingReason' | 'airRequestType'
> {
  return {
    samplingStratum: sampling?.stratum ?? null,
    inclusionProbability: sampling?.inclusionProbability ?? null,
    samplingReason: sampling?.reason ?? null,
    airRequestType: sampling?.airRequestType ?? null,
  };
}

function digestDto(dto: PricingRequestDto): string {
  return createHash('sha256').update(JSON.stringify(dto)).digest('hex').slice(0, 16);
}

/** Map a successful run to one row per SRT. */
export function toResultRows(
  requestId: string,
  dto: PricingRequestDto,
  result: PricingRunResult,
  runId: string | null,
  sampling?: SamplingMeta,
): ResultRow[] {
  const cost = estimateCostUsd(result.modelId, result.usage);
  const digest = digestDto(dto);
  let pricingDate: string | null = null;
  try {
    pricingDate = toYmd(dto.serviceDate);
  } catch {
    pricingDate = null;
  }

  return result.output.srtPrices.map((p) => ({
    requestId,
    runId,
    hrtId: p.hrtId ?? null,
    srtId: p.srtId ?? null,
    estimatedPatientResp: p.estimatedPatientResponsibility,
    benefitType: p.benefitType,
    confidence: p.confidence,
    reasoning: p.reasoning,
    sourceBreakdown: p.sourceBreakdown,
    warnings: result.output.warnings,
    totalLatencyMs: result.totalLatencyMs,
    stepLatencyMs: result.stepLatencyMs,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    estimatedCostUsd: cost,
    modelId: result.modelId,
    pricingDate,
    dtoDigest: digest,
    status: 'COMPLETED' as const,
    errorMessage: null,
    ...samplingCols(sampling),
  }));
}

/** Map a failed run to a single error row so the requestId is still recorded. */
export function toErrorRow(
  requestId: string,
  dto: PricingRequestDto,
  error: Error,
  sampling?: SamplingMeta,
): ResultRow {
  let pricingDate: string | null = null;
  try {
    pricingDate = toYmd(dto.serviceDate);
  } catch {
    pricingDate = null;
  }
  return {
    requestId,
    runId: null,
    hrtId: null,
    srtId: null,
    estimatedPatientResp: null,
    benefitType: null,
    confidence: 'UNABLE_TO_PRICE',
    reasoning: 'run failed before producing a price',
    sourceBreakdown: null,
    warnings: null,
    totalLatencyMs: null,
    stepLatencyMs: null,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    estimatedCostUsd: null,
    modelId: null,
    pricingDate,
    dtoDigest: digestDto(dto),
    status: 'ERROR',
    errorMessage: (error.message ?? String(error)).slice(0, 2000),
    ...samplingCols(sampling),
  };
}
