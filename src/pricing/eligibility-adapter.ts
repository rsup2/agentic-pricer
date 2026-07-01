/**
 * Adapts AIR-provided eligibility into the shape this service's own STEDI client
 * produces, so the synthesis path is identical whether eligibility came from AIR
 * or from our own 270/271 call.
 *
 * WHY: AIR already runs eligibility (Stedi / pVerify / Availity) before it prices.
 * Re-calling Stedi here is redundant and a significant error source ("many errors
 * came from STEDI"). So the shadow tap forwards AIR's normalized eligibility
 * (`transformedBenefits`, one per priced SRT/entity) and we PREFER it; we only
 * fall back to our own Stedi call when AIR sent nothing usable.
 *
 * CONTRACT: `dto.eligibility` carries AIR's `TransformedBenefitsResponse` objects
 * (the parsed, vendor-normalized eligibility — see air-service
 * insurance-parsing-manager). We reconstruct per-STC 271 tiles from them:
 *   - Each benefit tile keeps AIR's raw 271 record (`rawBenefit`) when present
 *     (Stedi path) — we pass that straight through for maximum fidelity.
 *   - Otherwise (pVerify / Availity) we synthesize a 271-style record from the
 *     normalized fields (benefitType -> code, amount/percent, network, level).
 * Output matches `checkEligibilityForStcs`: `{ results, groupNumber }`.
 *
 * Fully defensive: any shape surprise yields null so the caller falls back to a
 * live Stedi call rather than pricing off a malformed tile.
 */

type AnyRec = Record<string, unknown>;

/** Result element mirroring src/tools/stedi.ts checkEligibility (ok case). */
type OkResult = {
  ok: true;
  stc: string;
  response: { benefitsInformation: AnyRec[]; subscriber?: AnyRec; planInformation?: AnyRec };
};
export type AdaptedEligibility = { results: OkResult[]; groupNumber: string | null };

// AIR normalized benefitType -> X12 271 benefit code (see src/tools/stedi.ts):
//   A = Co-Insurance, B = Co-Payment, C = Deductible, G = Out-of-Pocket,
//   F = Limitation, I = Non-Covered.
const BENEFIT_TYPE_TO_CODE: Record<string, string> = {
  COPAY: 'B',
  COINSURANCE: 'A',
  DEDUCTIBLE: 'C',
  OUT_OF_POCKET: 'G',
  LIMITATION: 'F',
  NON_COVERED: 'I',
};

const NETWORK_TO_271: Record<string, string> = { IN: 'Y', OUT: 'N', BOTH: 'W' };

function asArray(v: unknown): AnyRec[] {
  if (Array.isArray(v)) return v as AnyRec[];
  if (v && typeof v === 'object') return [v as AnyRec];
  return [];
}

function str(v: unknown): string | undefined {
  return v == null || v === '' ? undefined : String(v);
}

/** Pull the list of TransformedBenefitsResponse objects out of whatever AIR sent. */
function transformedBenefitsList(eligibility: unknown): AnyRec[] {
  if (!eligibility || typeof eligibility !== 'object') return [];
  const e = eligibility as AnyRec;
  if (Array.isArray(e)) return e as AnyRec[];
  // accept { transformedBenefits: [...] } | { transformedBenefits: {...} } | a bare object
  if ('transformedBenefits' in e) return asArray(e.transformedBenefits);
  if ('coverageBreakdown' in e || 'coverageOverview' in e) return [e];
  return [];
}

/** Build a 271-style subscriber/planInformation block from AIR's coverageOverview. */
function subscriberFrom(ov: AnyRec | undefined): { subscriber: AnyRec; planInformation: AnyRec } {
  const o = ov ?? {};
  const groupNumber = str(o.groupNumber);
  return {
    subscriber: {
      memberId: str(o.memberId),
      groupNumber,
      firstName: str(o.subscriberFirstName),
      lastName: str(o.subscriberLastName),
      dateOfBirth: str(o.subscriberDob),
    },
    planInformation: {
      groupNumber,
      groupDescription: str(o.groupName),
      planNumber: str(o.planNumber),
      planName: str(o.planName),
    },
  };
}

/** One AIR benefit tile -> a 271 benefitsInformation record (prefer the raw one). */
function tileTo271(tile: AnyRec): { stc: string; record: AnyRec } | null {
  const detailCode = str(tile.detailCode);
  // Prefer AIR's retained raw 271 record (Stedi path) — highest fidelity.
  const raw = tile.rawBenefit as AnyRec | undefined;
  if (raw && typeof raw === 'object') {
    const stc = str((asArray(raw.serviceTypeCodes)[0] as unknown) ?? raw.serviceTypeCodes) ?? detailCode;
    if (!stc) return null;
    return { stc, record: raw };
  }
  // Synthesize from normalized fields (pVerify / Availity).
  if (!detailCode) return null;
  const benefitType = str(tile.benefitType)?.toUpperCase();
  const code = benefitType ? BENEFIT_TYPE_TO_CODE[benefitType] : undefined;
  if (!code) return null;
  const record: AnyRec = {
    code,
    serviceTypeCodes: [detailCode],
    coverageLevel: str(tile.level),
    inPlanNetworkIndicatorCode: NETWORK_TO_271[str(tile.inNetwork)?.toUpperCase() ?? ''] ?? undefined,
    timeQualifier: str(tile.remainingTimePeriod),
  };
  if (tile.amount != null) record.benefitAmount = tile.amount;
  if (tile.percent != null) record.benefitPercent = tile.percent;
  if (tile.remaining != null) record.remaining = tile.remaining;
  return { stc: detailCode, record };
}

/**
 * Synthesize plan-level (STC 30) accumulator records from coverageSpend so the
 * synthesis agent still sees remaining deductible / OOP even when AIR didn't
 * return an explicit STC-30 tile. Individual + family, in-network (the values the
 * pricer keys on); code C = deductible, G = OOP.
 */
function accumulatorRecords(spend: AnyRec | undefined): AnyRec[] {
  if (!spend || typeof spend !== 'object') return [];
  const recs: AnyRec[] = [];
  const push = (code: string, level: string, remaining: unknown, total: unknown) => {
    if (remaining == null && total == null) return;
    recs.push({
      code,
      serviceTypeCodes: ['30'],
      coverageLevel: level,
      inPlanNetworkIndicatorCode: 'Y',
      timeQualifier: 'Remaining',
      ...(remaining != null ? { benefitAmount: remaining } : {}),
      ...(total != null ? { total } : {}),
    });
  };
  const s = spend;
  push('C', 'IND', s.individualInNetworkRemainingDeductible, s.individualInNetworkDeductible);
  push('C', 'FAM', s.familyInNetworkRemainingDeductible, s.familyInNetworkDeductible);
  push('G', 'IND', s.individualInNetworkRemainingOutOfPocket, s.individualInNetworkOutOfPocket);
  push('G', 'FAM', s.familyInNetworkRemainingOutOfPocket, s.familyInNetworkOutOfPocket);
  return recs;
}

/**
 * Adapt AIR eligibility -> our STEDI result shape. Returns null when nothing
 * usable is present so the caller falls back to a live Stedi call.
 */
export function adaptAirEligibility(eligibility: unknown): AdaptedEligibility | null {
  const tbs = transformedBenefitsList(eligibility);
  if (tbs.length === 0) return null;

  // Merge benefit records across all forwarded tiles, keyed by STC.
  const byStc = new Map<string, AnyRec[]>();
  let subscriber: AnyRec | undefined;
  let planInformation: AnyRec | undefined;
  let groupNumber: string | null = null;

  for (const tb of tbs) {
    const ov = tb.coverageOverview as AnyRec | undefined;
    if (!subscriber) {
      const built = subscriberFrom(ov);
      subscriber = built.subscriber;
      planInformation = built.planInformation;
    }
    if (!groupNumber) groupNumber = str(ov?.groupNumber) ?? null;

    const breakdown = (tb.coverageBreakdown ?? {}) as AnyRec;
    const tiles = [
      ...asArray(breakdown.amounts),
      ...asArray(breakdown.limitations),
      ...asArray(breakdown.nonCovered),
    ];
    for (const tile of tiles) {
      const mapped = tileTo271(tile);
      if (!mapped) continue;
      const list = byStc.get(mapped.stc) ?? [];
      list.push(mapped.record);
      byStc.set(mapped.stc, list);
    }

    // plan-level accumulators from coverageSpend -> STC 30
    const acc = accumulatorRecords(tb.coverageSpend as AnyRec | undefined);
    if (acc.length) {
      const list = byStc.get('30') ?? [];
      list.push(...acc);
      byStc.set('30', list);
    }
  }

  if (byStc.size === 0) return null;

  const results: OkResult[] = [...byStc.entries()].map(([stc, benefitsInformation]) => ({
    ok: true,
    stc,
    response: { benefitsInformation, subscriber, planInformation },
  }));

  return { results, groupNumber };
}
