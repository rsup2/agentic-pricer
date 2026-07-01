import { env } from '../env.js';
import { synthesisAgent } from './synthesis-agent.js';
import { SynthesisOutputSchema, type PricingRequestDto, type StepLatency, type SynthesisOutput, type TokenUsage } from './types.js';
import {
  gatherPayerAndStc,
  gatherPatientHistory,
  gatherStedi,
  gatherGroupIntelligence,
} from './gather.js';
import { normalizeUsage } from './cost.js';
import { adaptAirEligibility } from './eligibility-adapter.js';

export type PricingRunResult = {
  output: SynthesisOutput;
  stepLatencyMs: StepLatency;
  totalLatencyMs: number;
  usage: TokenUsage;
  modelId: string;
  // Where eligibility came from: 'air' = AIR forwarded it (we skipped Stedi),
  // 'self' = we made our own Stedi call. Persisted so the shadow-vs-AIR analysis
  // can separate the preferred path from the fallback.
  eligibilitySource: 'air' | 'self';
};

/** time an async fn, returning [result, elapsedMs]. nowMs injected for testability. */
async function timed<T>(nowMs: () => number, fn: () => Promise<T>): Promise<[T, number]> {
  const start = nowMs();
  const result = await fn();
  return [result, Math.round(nowMs() - start)];
}

/**
 * Full pricing run for one request. Mirrors the agentic-pricer skill stages:
 *   parallel(payer+STC, patient history, ...) then STEDI (needs payer id),
 *   then group intel (needs group #), then synthesis agent.
 *
 * Per-step wall-clock latency and rolled-up token usage are captured for
 * persistence. `nowMs` is injected so callers/tests control the clock.
 */
export async function runPricing(
  dto: PricingRequestDto,
  nowMs: () => number = () => performance.now(),
): Promise<PricingRunResult> {
  const t0 = nowMs();
  const stepLatencyMs: StepLatency = {};

  // If AIR forwarded its already-computed eligibility, PREFER it and skip our own
  // Stedi entirely (both the STC probe during payer resolution and the per-STC
  // eligibility call). Unusable/absent => fall back to a live Stedi call (today's
  // behavior). AIR already ran eligibility, so re-calling Stedi is redundant work
  // and a known error source.
  const airEligibility = adaptAirEligibility(dto.eligibility);
  const eligibilitySource: 'air' | 'self' = airEligibility ? 'air' : 'self';

  // Phase 1: payer/STC and patient history can run concurrently.
  // STEDI needs the payer id, so it follows payer/STC; patient history is independent.
  const [[payerStc, payerStcMs], [history, historyMs]] = await Promise.all([
    timed(nowMs, () => gatherPayerAndStc(dto, { skipStediProbe: airEligibility != null })),
    timed(nowMs, () => gatherPatientHistory(dto)),
  ]);
  stepLatencyMs.payerStc = payerStcMs;
  stepLatencyMs.history = historyMs;

  // Phase 2: eligibility. Prefer AIR's forwarded tiles; else a live Stedi call.
  let stedi: Awaited<ReturnType<typeof gatherStedi>>;
  let stediMs = 0;
  if (airEligibility) {
    stedi = {
      results: airEligibility.results,
      groupNumber: airEligibility.groupNumber ?? dto.primaryInsurance.groupNumber ?? null,
    };
  } else {
    [stedi, stediMs] = await timed(nowMs, () =>
      gatherStedi(dto, payerStc.payerStediId, payerStc.uniqueStcs, {
        npi: payerStc.providerNpi,
        firstName: payerStc.providerFirstName,
        lastName: payerStc.providerLastName,
      }),
    );
  }
  stepLatencyMs.stedi = stediMs;

  // HARD GATE: a price requires a successful STEDI eligibility check. If EVERY
  // tile came back not-ok (e.g. AAA-44 provider-name rejection fails the whole
  // call), we do NOT run the synthesis agent and do NOT emit a price — own/group
  // history corroboration is not a substitute for live eligibility. Every SRT is
  // returned as UNABLE_TO_PRICE with the concrete STEDI error.
  // (Per product rule: at least one ok tile unlocks pricing; zero ok tiles blocks it.)
  const okTiles = stedi.results.filter((res) => res.ok);
  if (okTiles.length === 0) {
    const firstError =
      stedi.results.find((res) => !res.ok)?.error ??
      (payerStc.payerStediId
        ? 'STEDI eligibility returned no usable tiles'
        : 'no working payer id could be resolved for STEDI');
    return buildStediFailureResult(dto, payerStc, stedi, firstError, eligibilitySource, {
      stepLatencyMs,
      totalLatencyMs: Math.round(nowMs() - t0),
    });
  }

  // Phase 3: group intelligence (depends on group # from STEDI/DTO).
  const [group, groupMs] = await timed(nowMs, () =>
    gatherGroupIntelligence(dto, stedi.groupNumber),
  );
  stepLatencyMs.group = groupMs;

  // Phase 4: synthesis agent. Web search (if enabled on the agent) happens inside.
  const synthInput = buildSynthesisPrompt(dto, { payerStc, history, stedi, group });
  const [agentResult, synthMs] = await timed(nowMs, () =>
    synthesisAgent.generate(synthInput, {
      structuredOutput: { schema: SynthesisOutputSchema },
    } as never),
  );
  stepLatencyMs.synthesis = synthMs;
  // web latency is folded into synthesis when web search is an agent tool.

  // Tolerant extraction of structured object + usage (AI-SDK conventions, version-drift safe).
  const r = agentResult as Record<string, unknown>;
  const rawObject = (r.object ?? r.structuredOutput ?? r.experimental_output) as unknown;
  const output = SynthesisOutputSchema.parse(rawObject);
  const usage = normalizeUsage(r.usage as Record<string, unknown> | undefined);

  return {
    output,
    stepLatencyMs,
    totalLatencyMs: Math.round(nowMs() - t0),
    usage,
    modelId: env.SYNTHESIS_MODEL,
    eligibilitySource,
  };
}

/**
 * Build a no-price result when the STEDI gate trips (zero usable tiles). Every
 * SRT in the request is returned as UNABLE_TO_PRICE with the concrete STEDI
 * error; the synthesis agent is never called, so token usage is zero. This is
 * the hard enforcement of "no price without a successful eligibility check" —
 * own-history/group corroboration is deliberately NOT used as a fallback here.
 */
function buildStediFailureResult(
  dto: PricingRequestDto,
  payerStc: Awaited<ReturnType<typeof gatherPayerAndStc>>,
  stedi: Awaited<ReturnType<typeof gatherStedi>>,
  stediError: string,
  eligibilitySource: 'air' | 'self',
  timing: { stepLatencyMs: StepLatency; totalLatencyMs: number },
): PricingRunResult {
  void stedi; // reserved for richer per-tile reporting; gate decision already made upstream.
  const srtPrices = dto.hrtToSrts.flatMap((h) =>
    h.srtIds.map((srtId) => {
      const ctx = payerStc.srtContextBySrt[srtId];
      const chain = payerStc.stcBySrt[srtId];
      return {
        hrtId: h.hrtId,
        srtId,
        estimatedPatientResponsibility: null,
        benefitType: null,
        confidence: 'UNABLE_TO_PRICE' as const,
        reasoning: `No price produced: STEDI eligibility check did not succeed (${stediError}). A successful STEDI check is required before pricing; own-history/group corroboration is not a substitute.${ctx?.name ? ` Procedure: ${ctx.name}.` : ''}${chain ? ` STC chain primary=${chain.primary}.` : ''}`,
        sourceBreakdown: {
          stedi: `call failed / no usable tile (${stediError})`,
          ownHistoricals: 'not used — STEDI gate failed',
          groupHistoricals: 'not used — STEDI gate failed',
          webSearch: 'not attempted — STEDI gate failed',
          allowableSource: 'N/A — unable to price',
        },
      };
    }),
  );

  return {
    output: {
      srtPrices,
      warnings: [
        `STEDI gate: every eligibility tile failed (${stediError}); returned UNABLE_TO_PRICE for all ${srtPrices.length} SRT(s) without running the synthesis agent.`,
      ],
    },
    stepLatencyMs: timing.stepLatencyMs,
    totalLatencyMs: timing.totalLatencyMs,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
    modelId: env.SYNTHESIS_MODEL,
    eligibilitySource,
  };
}

/** Assemble the data bundle into the synthesis agent's prompt. */
function buildSynthesisPrompt(
  dto: PricingRequestDto,
  data: {
    payerStc: Awaited<ReturnType<typeof gatherPayerAndStc>>;
    history: Awaited<ReturnType<typeof gatherPatientHistory>>;
    stedi: Awaited<ReturnType<typeof gatherStedi>>;
    group: Awaited<ReturnType<typeof gatherGroupIntelligence>>;
  },
): string {
  const { payerStc, history, stedi, group } = data;
  const stediTiles = stedi.results.map((res) =>
    res.ok
      ? { stc: res.stc, ok: true, benefitsInformation: (res.response as Record<string, unknown>).benefitsInformation, subscriber: (res.response as Record<string, unknown>).subscriber, planInformation: (res.response as Record<string, unknown>).planInformation }
      : { stc: res.stc, ok: false, error: res.error },
  );

  return [
    `# Pricing request`,
    JSON.stringify(
      {
        orgId: dto.orgId,
        serviceDate: dto.serviceDate,
        payer: dto.primaryInsurance.payer,
        planName: dto.primaryInsurance.planName,
        state: dto.primaryInsurance.state,
        hrtToSrts: dto.hrtToSrts,
        coverageSpend: dto.coverageSpend ?? null,
      },
      null,
      2,
    ),
    ``,
    `# Procedure context per SRT (name, place-of-service, specialist flag, billing/CPT codes)`,
    `# Use this to recognize WHAT is being priced. A surgical CPT (e.g. CODE_GROUP "Surgery",`,
    `# high RVU, nonzero global days) or non-office POS is NOT an office visit — do not apply`,
    `# office-visit / E&M copay history to it. HRT_FLAGS is intentionally omitted (not trustworthy).`,
    JSON.stringify(payerStc.srtContextBySrt, null, 2),
    ``,
    `# Effective STC chain per SRT (org overrides applied). See the STC GLOSSARY in your`,
    `# instructions for what each code MEANS — do not guess. primary is the benefit class to price.`,
    JSON.stringify(payerStc.stcBySrt, null, 2),
    ``,
    `# STEDI eligibility (one tile-set per STC; STC 30 = plan-level accumulator)`,
    JSON.stringify(stediTiles, null, 2).slice(0, 60_000),
    ``,
    `# Patient's OWN prior claims (date-gated; ${history.note} — see the CLAIM HISTORY shape note in your instructions)`,
    JSON.stringify(history.rows, null, 2).slice(0, 40_000),
    ``,
    `# Group/plan intelligence (date-gated, base claim tables; per-line allowable/payment + patient copay/coinsurance/deductible — NOT a pnr column, ${group.note})`,
    JSON.stringify(group.rows, null, 2).slice(0, 60_000),
    ``,
    `Price each SRT per your procedure. Use web search for public plan documents if helpful.`,
    `Return ONLY the JSON object.`,
  ].join('\n');
}
