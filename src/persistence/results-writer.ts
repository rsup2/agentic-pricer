import { env, resultsTableFqn } from '../env.js';
import { executeWrite } from '../tools/snowflake.js';
import type { ResultRow } from './result-row.js';

/**
 * Micro-batched Snowflake writer. Buffers rows and flushes every
 * RESULTS_FLUSH_INTERVAL_MS or when RESULTS_FLUSH_MAX_ROWS is reached, so we
 * don't open a Snowflake session per price. Single-row inserts at completion
 * time would be fine volume-wise, but batching keeps warehouse churn down.
 *
 * VARIANT columns are inserted via PARSE_JSON over bound string params.
 */
class ResultsWriter {
  private buffer: ResultRow[] = [];
  private timer: NodeJS.Timeout | null = null;
  private flushing = false;

  enqueue(rows: ResultRow[]): void {
    this.buffer.push(...rows);
    if (this.buffer.length >= env.RESULTS_FLUSH_MAX_ROWS) {
      void this.flush();
    } else {
      this.ensureTimer();
    }
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, env.RESULTS_FLUSH_INTERVAL_MS);
    // don't keep the process alive purely for a pending flush
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    if (this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await this.insertBatch(batch);
    } catch (e) {
      // On failure, re-queue so we don't silently lose results (auditability).
      this.buffer.unshift(...batch);
      // eslint-disable-next-line no-console
      console.error('[results-writer] flush failed, re-queued', (e as Error).message);
      this.ensureTimer();
    } finally {
      this.flushing = false;
    }
  }

  private async insertBatch(rows: ResultRow[]): Promise<void> {
    // 28 columns per row. Build one multi-row INSERT ... SELECT ... UNION ALL.
    const COLS = [
      'REQUEST_ID', 'RUN_ID', 'HRT_ID', 'SRT_ID', 'ESTIMATED_PATIENT_RESP', 'BENEFIT_TYPE',
      'CONFIDENCE', 'REASONING', 'SOURCE_BREAKDOWN', 'WARNINGS', 'TOTAL_LATENCY_MS',
      'STEP_LATENCY_MS', 'INPUT_TOKENS', 'OUTPUT_TOKENS', 'CACHE_READ_TOKENS',
      'ESTIMATED_COST_USD', 'MODEL_ID', 'PRICING_DATE', 'DTO_DIGEST', 'STATUS', 'ERROR_MESSAGE',
      'SAMPLING_STRATUM', 'INCLUSION_PROBABILITY', 'SAMPLING_REASON', 'AIR_REQUEST_TYPE',
      'PRICER_VERSION', 'PRICER_COMMIT_URL', 'ELIGIBILITY_SOURCE',
    ];

    const binds: unknown[] = [];
    const selects = rows.map((r) => {
      // VARIANT columns get PARSE_JSON(?), the rest are plain ?. PRICING_DATE -> TO_DATE(?).
      const variantJson = (v: unknown) => JSON.stringify(v ?? null);
      const cells = [
        r.requestId, r.runId, r.hrtId, r.srtId, r.estimatedPatientResp, r.benefitType,
        r.confidence, r.reasoning, variantJson(r.sourceBreakdown), variantJson(r.warnings),
        r.totalLatencyMs, variantJson(r.stepLatencyMs), r.inputTokens, r.outputTokens,
        r.cacheReadTokens, r.estimatedCostUsd, r.modelId, r.pricingDate, r.dtoDigest,
        r.status, r.errorMessage,
        r.samplingStratum, r.inclusionProbability, r.samplingReason, r.airRequestType,
        r.pricerVersion, r.pricerCommitUrl, r.eligibilitySource,
      ];
      binds.push(...cells);
      // placeholders, with PARSE_JSON / TO_DATE wrapping for the right columns
      return (
        'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ' +
        'PARSE_JSON(?), PARSE_JSON(?), ?, PARSE_JSON(?), ' +
        '?, ?, ?, ?, ?, TO_DATE(?), ?, ?, ?, ' +
        '?, ?, ?, ?, ' +
        '?, ?, ?'
      );
    });

    const sql =
      `INSERT INTO ${resultsTableFqn} (${COLS.join(', ')})\n` +
      selects.join('\nUNION ALL\n');

    await executeWrite(sql, binds as never);
  }
}

export const resultsWriter = new ResultsWriter();
