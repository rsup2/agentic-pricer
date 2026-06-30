import pLimit from 'p-limit';
import { env } from './env.js';
import { runPricing } from './pricing/run.js';
import { resultsWriter } from './persistence/results-writer.js';
import { toResultRows, toErrorRow } from './persistence/result-row.js';
import type { PricingRequestDto, SamplingMeta } from './pricing/types.js';

/**
 * In-app concurrency gate. Caps the number of in-flight pricing runs at
 * MAX_CONCURRENT_RUNS; excess requests queue. Spikes degrade into a backlog
 * (acceptable for fire-and-forget shadow pricing) rather than a wall of 429s
 * from Anthropic / Snowflake / STEDI.
 *
 * The real scaling ceiling is downstream rate limits, not container CPU
 * (this workload is almost entirely I/O-bound). To add headroom, raise the
 * limit and/or scale Aptible replicas.
 */
const limit = pLimit(env.MAX_CONCURRENT_RUNS);

export function queueDepth(): number {
  return limit.pendingCount + limit.activeCount;
}

/**
 * Fire-and-forget: enqueue a pricing run behind the gate and return immediately.
 * The result (or an error row) is persisted to Snowflake keyed by requestId.
 */
export function enqueuePricingRun(
  requestId: string,
  dto: PricingRequestDto,
  sampling?: SamplingMeta,
): void {
  void limit(async () => {
    try {
      const result = await runPricing(dto);
      resultsWriter.enqueue(toResultRows(requestId, dto, result, /* runId */ requestId, sampling));
    } catch (e) {
      // Never lose the requestId: persist an error row so the join still works.
      resultsWriter.enqueue([toErrorRow(requestId, dto, e as Error, sampling)]);
      // eslint-disable-next-line no-console
      console.error(`[pricing-run] failed requestId=${requestId}:`, (e as Error).message);
    }
  });
}
