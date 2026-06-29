// We import `z` from @hono/zod-openapi (a thin wrapper over the same Zod 3
// instance) so these schemas double as OpenAPI definitions via `.openapi()`.
import { z } from '@hono/zod-openapi';

/**
 * The pricing request DTO — the same shape the live pricing engine receives.
 * Mirrors the DTO documented in the agentic-pricer skill. Kept permissive
 * (passthrough) so the shadow app never rejects a live request over a field
 * it doesn't strictly need.
 */
export const InsuranceSchema = z
  .object({
    memberId: z.string(),
    payer: z.string(),
    planName: z.string().optional(),
    state: z.string().optional(),
    groupNumber: z.string().optional(),
    insuredFirstName: z.string().optional(),
    insuredLastName: z.string().optional(),
  })
  .passthrough();

export const HrtToSrtSchema = z.object({
  hrtId: z.number(),
  srtIds: z.array(z.number()).min(1),
});

export const PricingRequestDtoSchema = z
  .object({
    consumerId: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    dateOfBirth: z.string(), // YYYY-MM-DD
    ehrPatientId: z.string().optional(),
    serviceDate: z.string(), // ISO8601; the "as-of" date for foreknowledge gating
    primaryInsurance: InsuranceSchema,
    npi: z.string().optional(),
    providerFirstName: z.string().optional(),
    providerLastName: z.string().optional(),
    orgId: z.number(),
    hrtToSrts: z.array(HrtToSrtSchema).min(1),
    // Optional accumulator at request time (coverageSpend). Highest-priority
    // accumulator source when present (see skill Step 5.A.7).
    coverageSpend: z.unknown().optional(),
  })
  .passthrough();

export type PricingRequestDto = z.infer<typeof PricingRequestDtoSchema>;

/** The HTTP body the caller posts to /price. */
export const PriceRequestSchema = z
  .object({
    requestId: z.string().min(1).openapi({ example: 'req-12345' }),
    dto: PricingRequestDtoSchema,
  })
  .openapi('PriceRequest');
export type PriceRequest = z.infer<typeof PriceRequestSchema>;

// --- agent output (per SRT) ---

export const SourceBreakdownSchema = z.object({
  stedi: z.string(),
  ownHistoricals: z.string(),
  groupHistoricals: z.string(),
  webSearch: z.string(),
  allowableSource: z.string(),
});

export const SrtPriceSchema = z.object({
  hrtId: z.number(),
  srtId: z.number(),
  estimatedPatientResponsibility: z.number().nullable(),
  benefitType: z.string().nullable(),
  confidence: z.enum(['HIGH', 'MEDIUM', 'LOW', 'UNABLE_TO_PRICE']),
  reasoning: z.string(),
  sourceBreakdown: SourceBreakdownSchema,
});
export type SrtPrice = z.infer<typeof SrtPriceSchema>;

export const SynthesisOutputSchema = z.object({
  srtPrices: z.array(SrtPriceSchema),
  warnings: z.array(z.string()).default([]),
});
export type SynthesisOutput = z.infer<typeof SynthesisOutputSchema>;

/** Per-step wall-clock latency, milliseconds. */
export type StepLatency = {
  payerStc?: number;
  history?: number;
  stedi?: number;
  group?: number;
  web?: number;
  synthesis?: number;
};

/** Token usage rolled up across all LLM calls in a run. */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
};
