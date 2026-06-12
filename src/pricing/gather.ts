import { executeQuery } from '../tools/snowflake.js';
import { checkEligibilityForStcs } from '../tools/stedi.js';
import {
  PAYER_LOOKUP_SQL,
  stcLookupSql,
  patientHistorySql,
  groupIntelligenceSql,
  buildNumericInList,
} from '../tools/queries.js';
import { resolveStcChain, type StcChain } from './stc-overrides.js';
import type { PricingRequestDto } from './types.js';

/** YYYY-MM-DD from an ISO date string; validated so it can't carry injection. */
export function toYmd(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`serviceDate must be ISO (YYYY-MM-DD...), got: ${iso}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

type StcRow = {
  SRT_ID: number;
  PRIMARY_SERVICE_TYPE_CODE: string | null;
  SECONDARY_SERVICE_TYPE_CODE: string | null;
};

/** 1a + 1b: payer Stedi id, and the effective STC chain per SRT (with overrides). */
export async function gatherPayerAndStc(dto: PricingRequestDto): Promise<{
  payerStediId: string | null;
  payerMatches: Array<{ stedi_payer_id: string; name: string }>;
  stcBySrt: Record<number, StcChain>;
  uniqueStcs: string[];
}> {
  const allSrtIds = Array.from(new Set(dto.hrtToSrts.flatMap((h) => h.srtIds)));

  const [payerRows, stcRows] = await Promise.all([
    executeQuery<{ STEDI_PAYER_ID: string; NAME: string }>(PAYER_LOOKUP_SQL, [
      `%${dto.primaryInsurance.payer}%`,
    ]),
    executeQuery<StcRow>(stcLookupSql(buildNumericInList(allSrtIds))),
  ]);

  const payerMatches = payerRows.map((r) => ({ stedi_payer_id: r.STEDI_PAYER_ID, name: r.NAME }));
  // prefer state match if multiple; else first.
  const state = dto.primaryInsurance.state;
  const payerStediId =
    payerMatches.find((p) => state && p.name.toLowerCase().includes(state.toLowerCase()))
      ?.stedi_payer_id ??
    payerMatches[0]?.stedi_payer_id ??
    null;

  const dbDefaults = new Map<number, StcChain>();
  for (const row of stcRows) {
    dbDefaults.set(row.SRT_ID, {
      primary: row.PRIMARY_SERVICE_TYPE_CODE ?? '30',
      secondaries: row.SECONDARY_SERVICE_TYPE_CODE
        ? row.SECONDARY_SERVICE_TYPE_CODE.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
    });
  }

  const stcBySrt: Record<number, StcChain> = {};
  for (const h of dto.hrtToSrts) {
    for (const srtId of h.srtIds) {
      const dbDefault = dbDefaults.get(srtId) ?? { primary: '30', secondaries: [] };
      stcBySrt[srtId] = resolveStcChain(
        { orgId: dto.orgId, payer: dto.primaryInsurance.payer, hrtId: h.hrtId, srtId },
        dbDefault,
      );
    }
  }

  const uniqueStcs = Array.from(
    new Set(Object.values(stcBySrt).flatMap((c) => [c.primary, ...c.secondaries])),
  );

  return { payerStediId, payerMatches, stcBySrt, uniqueStcs };
}

/** 1c: own patient claim history (date-gated). Returns rows + a flag for emptiness. */
export async function gatherPatientHistory(dto: PricingRequestDto): Promise<{
  rows: Record<string, unknown>[];
  note: string;
}> {
  if (!dto.ehrPatientId) {
    return { rows: [], note: 'no ehrPatientId on DTO — patient history skipped' };
  }
  const rows = await executeQuery(
    patientHistorySql({ serviceDate: toYmd(dto.serviceDate), orgId: dto.orgId, ehrPatientId: dto.ehrPatientId }),
  );
  return { rows, note: rows.length ? `${rows.length} prior closed-claim rows` : 'no prior claims (new patient)' };
}

/** Step 2: STEDI eligibility for all unique STCs + STC 30. */
export async function gatherStedi(
  dto: PricingRequestDto,
  payerStediId: string | null,
  uniqueStcs: string[],
): Promise<{ results: Awaited<ReturnType<typeof checkEligibilityForStcs>>; groupNumber: string | null }> {
  if (!payerStediId) {
    return { results: [], groupNumber: dto.primaryInsurance.groupNumber ?? null };
  }
  const results = await checkEligibilityForStcs(
    {
      tradingPartnerServiceId: payerStediId,
      npi: dto.npi,
      providerLastName: dto.providerLastName,
      memberId: dto.primaryInsurance.memberId,
      subscriberFirstName: dto.primaryInsurance.insuredFirstName ?? dto.firstName,
      subscriberLastName: dto.primaryInsurance.insuredLastName ?? dto.lastName,
      dateOfBirth: dto.dateOfBirth,
      dateOfService: toYmd(dto.serviceDate),
    },
    uniqueStcs,
  );

  // group number: DTO first, then STEDI STC 30 response.
  let groupNumber = dto.primaryInsurance.groupNumber ?? null;
  if (!groupNumber) {
    const stc30 = results.find((r) => r.ok && r.stc === '30');
    if (stc30 && stc30.ok) {
      const sub = (stc30.response.subscriber ?? {}) as Record<string, unknown>;
      groupNumber = (sub.groupNumber as string) ?? null;
    }
  }
  return { results, groupNumber };
}

/** Step 3: group/plan intelligence (date-gated), capped in-memory to keep tokens sane. */
export async function gatherGroupIntelligence(
  dto: PricingRequestDto,
  groupNumber: string | null,
): Promise<{ rows: Record<string, unknown>[]; note: string }> {
  if (!groupNumber) {
    return { rows: [], note: 'no group number available — group intelligence skipped' };
  }
  const rows = await executeQuery(
    groupIntelligenceSql({ serviceDate: toYmd(dto.serviceDate), orgId: dto.orgId, groupNumber }),
  );
  // Cap to ~200 rows, most recent first, to bound synthesis token cost.
  const capped = rows.slice(0, 200);
  return {
    rows: capped,
    note:
      rows.length > capped.length
        ? `group ${groupNumber}: ${rows.length} rows, capped to ${capped.length} most-recent`
        : `group ${groupNumber}: ${rows.length} rows`,
  };
}
