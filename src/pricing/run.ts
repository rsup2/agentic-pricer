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

export type PricingRunResult = {
  output: SynthesisOutput;
  stepLatencyMs: StepLatency;
  totalLatencyMs: number;
  usage: TokenUsage;
  modelId: string;
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

  // Phase 1: payer/STC and patient history can run concurrently.
  // STEDI needs the payer id, so it follows payer/STC; patient history is independent.
  const [[payerStc, payerStcMs], [history, historyMs]] = await Promise.all([
    timed(nowMs, () => gatherPayerAndStc(dto)),
    timed(nowMs, () => gatherPatientHistory(dto)),
  ]);
  stepLatencyMs.payerStc = payerStcMs;
  stepLatencyMs.history = historyMs;

  // Phase 2: STEDI (depends on payer id + STC chain).
  const [stedi, stediMs] = await timed(nowMs, () =>
    gatherStedi(dto, payerStc.payerStediId, payerStc.uniqueStcs),
  );
  stepLatencyMs.stedi = stediMs;

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
    `# Effective STC chain per SRT (org overrides applied)`,
    JSON.stringify(payerStc.stcBySrt, null, 2),
    ``,
    `# STEDI eligibility (one tile-set per STC; STC 30 = plan-level accumulator)`,
    JSON.stringify(stediTiles, null, 2).slice(0, 60_000),
    ``,
    `# Patient's OWN prior claims (date-gated, ${history.note})`,
    JSON.stringify(history.rows, null, 2).slice(0, 40_000),
    ``,
    `# Group/plan intelligence (date-gated, ${group.note})`,
    JSON.stringify(group.rows, null, 2).slice(0, 60_000),
    ``,
    `Price each SRT per your procedure. Use web search for public plan documents if helpful.`,
    `Return ONLY the JSON object.`,
  ].join('\n');
}
