/**
 * Frequency-table encoding for claim history.
 *
 * The synthesis agent used to receive raw JSON row dumps of own + group claim
 * history (up to ~400 own lines and ~200 group lines). That is expensive in
 * tokens and, per the product owner, hard for the model to reason over. Instead
 * we collapse the rows into a per-CPT frequency table: "for procedure X, N prior
 * lines, this is the distribution of patient responsibility" — e.g. "241/500 of
 * this CPT adjudicated to $0". This cuts synthesis token cost and latency (both
 * now formal go/no-go gates) and makes the modal outcome legible at a glance.
 *
 * Two row shapes are handled (they come from two different queries):
 *   - BASE shape (Athena own-history + ALL group intelligence, from
 *     buildHistoryStyleQuery): per-line COPAY / COINS / DEDUCT / ALLOWABLE /
 *     PAYMENT columns. Patient responsibility per line = copay + coins + deduct.
 *   - CANONICAL shape (Experity/MedRite own-history, from CANONICAL_OWN_HISTORY_SQL):
 *     a single PNR (already-adjudicated patient responsibility) + LIST_PRICE.
 *
 * The plan-level accumulator columns on base rows (ind_deductible_remaining, etc.)
 * are intentionally dropped here — those are historical snapshots per claim; the
 * CURRENT accumulator state comes from STEDI STC 30 / coverageSpend, not history.
 */

type Row = Record<string, unknown>;

export type HistoryShape = 'base' | 'canonical';

/** Distribution of a dollar quantity across the prior lines for one CPT. */
type MoneyDistribution = {
  zeroRate: number; // fraction of lines at exactly $0 (carve-out / full-coverage signal)
  median: number;
  mode: number; // most common exact value (ties -> smallest)
  min: number;
  max: number;
  p25: number;
  p75: number;
};

export type CodeSummary = {
  code: string;
  n: number; // prior lines for this CPT
  patientResp: MoneyDistribution; // base: copay+coins+deduct ; canonical: pnr
  /** base only: # lines where each component was > 0 (benefit-type signal) */
  benefitMix?: { copay: number; coinsurance: number; deductible: number };
  /** base: median allowable ; canonical: median list_price (null when absent) */
  allowableMedian: number | null;
  lastSeen: string | null; // most recent service date for this CPT (YYYY-MM-DD)
  modifiers?: string[]; // canonical only: distinct non-empty modifiers seen
  plans?: string[]; // distinct plan/package descriptions seen (capped)
};

export type HistorySummary = {
  shape: HistoryShape;
  totalLines: number;
  distinctCodes: number;
  codesShown: number; // byCode may be capped for token budget
  byCode: CodeSummary[]; // sorted by n desc
};

const MAX_CODES = 60; // cap distinct CPTs emitted to bound tokens
const MAX_PLANS = 4;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Read a column case-insensitively (Snowflake upvcases unquoted identifiers). */
function pick(row: Row, ...names: string[]): unknown {
  for (const name of names) {
    if (row[name] !== undefined) return row[name];
    const up = name.toUpperCase();
    if (row[up] !== undefined) return row[up];
    const lo = name.toLowerCase();
    if (row[lo] !== undefined) return row[lo];
  }
  return undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Linear-interpolated quantile over an ascending-sorted array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Most common exact value; ties resolved to the smallest value. */
function mode(values: number[]): number {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0];
  let bestCount = -1;
  for (const [v, c] of counts) {
    if (c > bestCount || (c === bestCount && v < best)) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function distribution(values: number[]): MoneyDistribution {
  const sorted = [...values].sort((a, b) => a - b);
  const zeros = sorted.filter((v) => v === 0).length;
  return {
    zeroRate: round2(zeros / sorted.length),
    median: round2(quantile(sorted, 0.5)),
    mode: round2(mode(sorted)),
    min: round2(sorted[0]),
    max: round2(sorted[sorted.length - 1]),
    p25: round2(quantile(sorted, 0.25)),
    p75: round2(quantile(sorted, 0.75)),
  };
}

function medianOrNull(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return round2(quantile(sorted, 0.5));
}

/** YYYY-MM-DD from a date/string cell, or null. */
function ymd(v: unknown): string | null {
  if (!v) return null;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Detect the row shape from its columns (canonical carries PNR / PROCEDURE_CODE). */
export function detectShape(rows: Row[]): HistoryShape {
  if (rows.length === 0) return 'base';
  const r = rows[0];
  // Require BOTH canonical markers (not either) so a stray column can't misclassify a base row.
  if (pick(r, 'pnr') !== undefined && pick(r, 'procedure_code') !== undefined) return 'canonical';
  return 'base';
}

type Accum = {
  resp: number[];
  copayHits: number;
  coinsHits: number;
  deductHits: number;
  allowables: number[];
  lastSeen: string | null;
  modifiers: Set<string>;
  plans: Set<string>;
};

function newAccum(): Accum {
  return {
    resp: [],
    copayHits: 0,
    coinsHits: 0,
    deductHits: 0,
    allowables: [],
    lastSeen: null,
    modifiers: new Set(),
    plans: new Set(),
  };
}

function bumpLastSeen(acc: Accum, date: string | null): void {
  if (date && (acc.lastSeen === null || date > acc.lastSeen)) acc.lastSeen = date;
}

/**
 * Collapse raw claim-history rows into a per-CPT frequency table. `shape` may be
 * supplied by the caller (it knows which query produced the rows) or inferred.
 */
export function summarizeHistory(rows: Row[], shape?: HistoryShape): HistorySummary {
  const resolved = shape ?? detectShape(rows);
  const byCode = new Map<string, Accum>();

  for (const row of rows) {
    if (resolved === 'canonical') {
      const code = String(pick(row, 'procedure_code') ?? '').trim() || 'UNKNOWN';
      const acc = byCode.get(code) ?? newAccum();
      byCode.set(code, acc);
      const pnr = num(pick(row, 'pnr'));
      if (pnr !== null) acc.resp.push(pnr);
      const list = num(pick(row, 'list_price'));
      if (list !== null) acc.allowables.push(list);
      bumpLastSeen(acc, ymd(pick(row, 'date_of_service')));
      const mod = String(pick(row, 'modifier') ?? '').trim();
      if (mod) acc.modifiers.add(mod);
      const plan = String(pick(row, 'payer_plan_name') ?? '').trim();
      if (plan) acc.plans.add(plan);
    } else {
      const code = String(pick(row, 'procedurecode') ?? '').trim() || 'UNKNOWN';
      const acc = byCode.get(code) ?? newAccum();
      byCode.set(code, acc);
      const copay = num(pick(row, 'copay')) ?? 0;
      const coins = num(pick(row, 'coins')) ?? 0;
      const deduct = num(pick(row, 'deduct')) ?? 0;
      acc.resp.push(round2(copay + coins + deduct));
      if (copay > 0) acc.copayHits += 1;
      if (coins > 0) acc.coinsHits += 1;
      if (deduct > 0) acc.deductHits += 1;
      const allowable = num(pick(row, 'allowable'));
      if (allowable !== null) acc.allowables.push(allowable);
      bumpLastSeen(acc, ymd(pick(row, 'claimservicedate')));
      const plan = String(pick(row, 'primary_package') ?? pick(row, 'plancoveragedesc') ?? '').trim();
      if (plan) acc.plans.add(plan);
    }
  }

  const entries = [...byCode.entries()]
    .map<CodeSummary>(([code, acc]) => {
      const base: CodeSummary = {
        code,
        n: acc.resp.length,
        patientResp: distribution(acc.resp.length ? acc.resp : [0]),
        allowableMedian: medianOrNull(acc.allowables),
        lastSeen: acc.lastSeen,
        plans: acc.plans.size ? [...acc.plans].slice(0, MAX_PLANS) : undefined,
      };
      if (resolved === 'base') {
        base.benefitMix = { copay: acc.copayHits, coinsurance: acc.coinsHits, deductible: acc.deductHits };
      } else if (acc.modifiers.size) {
        base.modifiers = [...acc.modifiers];
      }
      return base;
    })
    // Drop codes with no numeric patient-cost data (n=0) — don't emit a synthetic $0.
    .filter((e) => e.n > 0)
    .sort((a, b) => b.n - a.n);

  const shown = entries.slice(0, MAX_CODES);
  return {
    shape: resolved,
    totalLines: rows.length,
    distinctCodes: entries.length,
    codesShown: shown.length,
    byCode: shown,
  };
}
