/**
 * Adapts AIR-forwarded eligibility into the shape this service's own STEDI client
 * produces, so the synthesis path is identical whether eligibility came from AIR
 * or from our own 270/271 call.
 *
 * WHY: AIR already runs eligibility before it prices; re-calling Stedi here is
 * redundant and a known error source. So the shadow tap forwards AIR's eligibility
 * and we PREFER it, falling back to our own Stedi call only when nothing usable
 * was sent.
 *
 * CONTRACT: AIR forwards the **raw** per-STC coverage responses — the untouched
 * vendor payload (for Stedi, the 271 JSON: `{ benefitsInformation, subscriber,
 * planInformation }`) — NOT its parsed `transformedBenefits`. We deliberately take
 * the raw response so the shadow interprets eligibility independently rather than
 * inheriting AIR's parsing/tiling logic (the whole point of an independent shadow).
 * The raw Stedi 271 is exactly what our own Stedi client returns, so this is a
 * drop-in: no reshaping.
 *
 * Wire shape (`dto.eligibility`): `[{ stc, response }]`, `response` = raw 271.
 * Non-Stedi vendors (pVerify/Availity) have a different raw shape with no
 * `benefitsInformation`; those entries are dropped, so such requests fall back to
 * a live Stedi call. Fully defensive: nothing usable => null => caller falls back.
 */

import type { StediResult } from '../tools/stedi.js';

type AnyRec = Record<string, unknown>;

/** The ok variant of the authoritative Stedi result type (shape drift => compile error here). */
type OkResult = Extract<StediResult, { ok: true }>;
export type AdaptedEligibility = { results: OkResult[]; groupNumber: string | null };

function str(v: unknown): string | undefined {
  return v == null || v === '' ? undefined : String(v);
}

/** Normalize whatever AIR sent into a `[{ stc, response }]` list. */
function asEntries(eligibility: unknown): Array<{ stc: unknown; response: unknown }> {
  if (Array.isArray(eligibility)) return eligibility as Array<{ stc: unknown; response: unknown }>;
  if (eligibility && typeof eligibility === 'object') {
    const e = eligibility as AnyRec;
    if (Array.isArray(e.results)) return e.results as Array<{ stc: unknown; response: unknown }>;
  }
  return [];
}

/** Group number from any tile's 271 subscriber / planInformation. */
function firstGroupNumber(results: OkResult[]): string | null {
  for (const r of results) {
    const resp = r.response as AnyRec;
    const sub = (resp.subscriber ?? {}) as AnyRec;
    const plan = (resp.planInformation ?? {}) as AnyRec;
    const g = str(sub.groupNumber) ?? str(plan.groupNumber);
    if (g) return g;
  }
  return null;
}

/**
 * Adapt AIR-forwarded raw eligibility -> our STEDI result shape. Keeps one tile
 * per STC (mirroring our own client, which makes one call per unique STC) and
 * only accepts 271-shaped responses (have `benefitsInformation`); anything else
 * is dropped. Returns null when nothing usable is present so the caller falls
 * back to a live Stedi call.
 */
export function adaptAirEligibility(eligibility: unknown): AdaptedEligibility | null {
  const entries = asEntries(eligibility);
  const results: OkResult[] = [];
  const seenStc = new Set<string>();

  for (const e of entries) {
    const response = e?.response;
    if (!response || typeof response !== 'object') continue;
    // A usable eligibility response is 271-shaped (has benefitsInformation). This
    // naturally excludes non-Stedi vendor payloads, which then fall back to Stedi.
    if (!Array.isArray((response as AnyRec).benefitsInformation)) continue;
    const stc = str(e.stc);
    if (!stc || seenStc.has(stc)) continue;
    seenStc.add(stc);
    results.push({ ok: true, stc, response: response as Record<string, unknown> });
  }

  if (results.length === 0) return null;
  return { results, groupNumber: firstGroupNumber(results) };
}
