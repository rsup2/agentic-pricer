import { executeQuery } from "../tools/snowflake.js";
import { checkEligibility, checkEligibilityForStcs } from "../tools/stedi.js";
import {
  PAYER_LOOKUP_SQL,
  DEFAULT_PROVIDER_SQL,
  PROVIDER_BY_NPI_SQL,
  stcLookupSql,
  srtContextSql,
  patientHistorySql,
  CANONICAL_OWN_HISTORY_SQL,
  CANONICAL_GROUP_HISTORY_SQL,
  groupIntelligenceSql,
  buildNumericInList,
} from "../tools/queries.js";
import { resolveStcChain, type StcChain } from "./stc-overrides.js";
import type { PricingRequestDto } from "./types.js";

/** YYYY-MM-DD from an ISO date string; validated so it can't carry injection. */
export function toYmd(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`serviceDate must be ISO (YYYY-MM-DD...), got: ${iso}`);
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/**
 * A real NPI is exactly 10 numeric digits. Anything with letters or the wrong
 * length is a placeholder/test value (e.g. "NEUROTEST1") and must NOT be sent to
 * Stedi — return null so the caller falls back to the org default provider rather
 * than issuing an eligibility call with a bogus provider id. (Trims surrounding
 * whitespace; does not validate the NPI Luhn check digit — length+numeric is the
 * guard we need here.)
 */
export function validNpi(npi: string | null | undefined): string | null {
  const trimmed = (npi ?? "").trim();
  return /^\d{10}$/.test(trimmed) ? trimmed : null;
}

type StcRow = {
  SRT_ID: number;
  PRIMARY_SERVICE_TYPE: string | null;
  SECONDARY_SERVICE_TYPE: string | null;
};

type SrtContextRow = {
  SRT_ID: number;
  SRT_NAME: string | null;
  SRT_DESCRIPTION: string | null;
  POS_CODE: string | null;
  IS_SPECIALIST: boolean | null;
  TERTIARY_SERVICE_TYPE: string | null;
  BILLING_CODE: string | null;
  CODE_GROUP: string | null;
  CATEGORY: string | null;
  BILLING_DESCRIPTION: string | null;
  RVU: number | null;
  GLOBAL_DAYS: number | null;
};

/**
 * Human-readable procedure context for one SRT: its name/description/POS plus the
 * billing (CPT/HCPCS) codes it maps to. Handed to the synthesis agent so it can
 * recognize what's actually being priced (e.g. a knee arthroplasty vs an office
 * visit) instead of free-associating off the bare STC code.
 */
export type SrtContext = {
  srtId: number;
  name: string | null;
  description: string | null;
  posCode: string | null;
  isSpecialist: boolean | null;
  tertiaryStc: string | null;
  billingCodes: Array<{
    code: string;
    codeGroup: string | null;
    category: string | null;
    description: string | null;
    rvu: number | null;
    globalDays: number | null;
  }>;
};

/** 1a + 1b: payer Stedi id, the effective provider NPI, and the STC chain per SRT. */
export async function gatherPayerAndStc(
  dto: PricingRequestDto,
  opts: { skipStediProbe?: boolean } = {},
): Promise<{
  payerStediId: string | null;
  providerNpi: string | null;
  providerFirstName: string | null;
  providerLastName: string | null;
  payerMatches: Array<{ availity_payer_code: string; name: string }>;
  payerCandidates: string[];
  stcBySrt: Record<number, StcChain>;
  srtContextBySrt: Record<number, SrtContext>;
  uniqueStcs: string[];
}> {
  const allSrtIds = Array.from(new Set(dto.hrtToSrts.flatMap((h) => h.srtIds)));

  const [payerRows, stcRows, srtContextRows, provider] = await Promise.all([
    executeQuery<{ AVAILITY_PAYER_CODE: string; PAYER_NAME: string }>(PAYER_LOOKUP_SQL, [
      `%${dto.primaryInsurance.payer}%`,
    ]),
    executeQuery<StcRow>(stcLookupSql(buildNumericInList(allSrtIds))),
    executeQuery<SrtContextRow>(srtContextSql(buildNumericInList(allSrtIds))),
    resolveProvider(dto),
  ]);

  const payerMatches = payerRows.map((r) => ({
    availity_payer_code: r.AVAILITY_PAYER_CODE,
    name: r.PAYER_NAME,
  }));

  // Order rows: a state-matching payer row first (if any), then the rest in
  // query order. Then flatten each row's comma-separated code list into an
  // ordered, deduped candidate list. Codes are strings (leading zeros matter).
  const state = dto.primaryInsurance.state;
  const stateMatch = state ? payerMatches.find((p) => p.name.toLowerCase().includes(state.toLowerCase())) : undefined;
  const orderedRows = stateMatch ? [stateMatch, ...payerMatches.filter((p) => p !== stateMatch)] : payerMatches;

  const seen = new Set<string>();
  const payerCandidates: string[] = [];
  for (const row of orderedRows) {
    for (const raw of (row.availity_payer_code ?? "").split(",")) {
      const code = raw.trim();
      if (code && !seen.has(code)) {
        seen.add(code);
        payerCandidates.push(code);
      }
    }
  }

  // Pick the first candidate id that Stedi actually accepts. Probe with STC 30
  // (plan-level) since it's the cheapest universal check; the first ok:true wins.
  // The probe needs the same provider (NPI + last name) the full run will use.
  // Skipped when AIR forwarded eligibility — we won't call Stedi, so no id needed
  // (and this avoids a redundant Stedi probe on the preferred path).
  const payerStediId = opts.skipStediProbe
    ? null
    : await pickWorkingPayerId(dto, payerCandidates, provider);

  const dbDefaults = new Map<number, StcChain>();
  for (const row of stcRows) {
    dbDefaults.set(row.SRT_ID, {
      primary: row.PRIMARY_SERVICE_TYPE ?? "30",
      secondaries: row.SECONDARY_SERVICE_TYPE
        ? row.SECONDARY_SERVICE_TYPE.split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
    });
  }

  const stcBySrt: Record<number, StcChain> = {};
  for (const h of dto.hrtToSrts) {
    for (const srtId of h.srtIds) {
      const dbDefault = dbDefaults.get(srtId) ?? { primary: "30", secondaries: [] };
      stcBySrt[srtId] = resolveStcChain(
        { orgId: dto.orgId, payer: dto.primaryInsurance.payer, hrtId: h.hrtId, srtId },
        dbDefault,
      );
    }
  }

  const uniqueStcs = Array.from(new Set(Object.values(stcBySrt).flatMap((c) => [c.primary, ...c.secondaries])));

  // Aggregate the (srt, billing_code) rows into one SrtContext per SRT.
  const srtContextBySrt: Record<number, SrtContext> = {};
  for (const row of srtContextRows) {
    const ctx = (srtContextBySrt[row.SRT_ID] ??= {
      srtId: row.SRT_ID,
      name: row.SRT_NAME,
      description: row.SRT_DESCRIPTION,
      posCode: row.POS_CODE,
      isSpecialist: row.IS_SPECIALIST,
      tertiaryStc: row.TERTIARY_SERVICE_TYPE,
      billingCodes: [],
    });
    // LEFT JOIN: an SRT with no billing-code mapping yields a single row with a
    // null BILLING_CODE — don't push a phantom code for it.
    if (row.BILLING_CODE) {
      ctx.billingCodes.push({
        code: row.BILLING_CODE,
        codeGroup: row.CODE_GROUP,
        category: row.CATEGORY,
        description: row.BILLING_DESCRIPTION,
        rvu: row.RVU,
        globalDays: row.GLOBAL_DAYS,
      });
    }
  }

  return {
    payerStediId,
    providerNpi: provider.npi,
    providerFirstName: provider.firstName,
    providerLastName: provider.lastName,
    payerMatches,
    payerCandidates,
    stcBySrt,
    srtContextBySrt,
    uniqueStcs,
  };
}

/**
 * The provider (NPI + first/last name) to send to Stedi. Stedi requires BOTH an
 * NPI and a name, and for an NPI-1 (individual) provider it rejects a person loop
 * lacking a FIRST name with AAA-44 "Invalid/Missing Provider Name" — so we always
 * resolve a first name when we can. Prefer what's on the request DTO; otherwise
 * fall back to the org's default billing provider (default_provider joined to
 * provider on npi). When the org has several rows, prefer one whose STATE matches
 * the insurance state, else the first. Any field may be null if unavailable.
 *
 * Backfill: if the DTO supplies an NPI but no first name (the common case), look
 * the provider up by NPI in the provider table to fill in first (and last) name.
 */
async function resolveProvider(
  dto: PricingRequestDto,
): Promise<{ npi: string | null; firstName: string | null; lastName: string | null }> {
  // If the DTO carries a VALID NPI (exactly 10 digits), trust it; backfill the
  // name from the provider table when the DTO didn't give a first name (DTO-
  // provided names still win). A non-numeric/malformed NPI (e.g. "NEUROTEST1")
  // is ignored here so we fall through to the org default provider below rather
  // than sending a bogus id to Stedi.
  const dtoNpi = validNpi(dto.npi);
  if (dtoNpi) {
    if (dto.providerFirstName) {
      return { npi: dtoNpi, firstName: dto.providerFirstName, lastName: dto.providerLastName ?? null };
    }
    const byNpi = await executeQuery<{ NPI: string; FIRST_NAME: string | null; LAST_NAME: string | null }>(
      PROVIDER_BY_NPI_SQL,
      [dtoNpi],
    );
    const p = byNpi[0];
    return {
      npi: dtoNpi,
      firstName: p?.FIRST_NAME ?? null,
      lastName: dto.providerLastName ?? p?.LAST_NAME ?? null,
    };
  }
  const rows = await executeQuery<{ NPI: string; STATE: string | null; FIRST_NAME: string | null; LAST_NAME: string | null }>(
    DEFAULT_PROVIDER_SQL,
    [dto.orgId],
  );
  if (rows.length === 0) {
    return { npi: null, firstName: dto.providerFirstName ?? null, lastName: dto.providerLastName ?? null };
  }
  const state = dto.primaryInsurance.state;
  const stateMatch = state
    ? rows.find((r) => (r.STATE ?? "").toLowerCase() === state.toLowerCase())
    : undefined;
  const row = stateMatch ?? rows[0];
  // DTO-provided names still win over the looked-up ones if present. Validate the
  // org-default NPI too — a test/placeholder NPI (e.g. "NEUROTEST1" seen on some
  // test orgs) in default_provider must not be sent to Stedi either.
  return {
    npi: validNpi(row.NPI),
    firstName: dto.providerFirstName ?? row.FIRST_NAME ?? null,
    lastName: dto.providerLastName ?? row.LAST_NAME ?? null,
  };
}

/**
 * Try each candidate payer id in order against Stedi (one STC-30 probe each),
 * returning the first that Stedi accepts (ok:true). Returns null if the list is
 * empty or every candidate is rejected. Sequential by design: we stop at the
 * first working id rather than spending a probe on every candidate.
 */
async function pickWorkingPayerId(
  dto: PricingRequestDto,
  candidates: string[],
  provider: { npi: string | null; firstName: string | null; lastName: string | null },
): Promise<string | null> {
  for (const id of candidates) {
    const probe = await checkEligibility({
      tradingPartnerServiceId: id,
      npi: provider.npi ?? undefined,
      providerFirstName: provider.firstName ?? undefined,
      providerLastName: provider.lastName ?? undefined,
      memberId: dto.primaryInsurance.memberId,
      subscriberFirstName: dto.primaryInsurance.insuredFirstName ?? dto.firstName,
      subscriberLastName: dto.primaryInsurance.insuredLastName ?? dto.lastName,
      dateOfBirth: dto.dateOfBirth,
      dateOfService: toYmd(dto.serviceDate),
      serviceTypeCodes: ["30"],
    });
    if (probe.ok) return id;
  }
  // No candidate worked: fall back to the first id (if any) so the downstream
  // full STC run still surfaces a concrete Stedi error rather than skipping.
  return candidates[0] ?? null;
}

/**
 * 1c: own patient claim history (date-gated). Routed by EHR:
 *  - ATHENA (request carries an ehrPatientId): UNCHANGED patient-keyed base_athena
 *    query — patient-specific, mirrors how AIR keys own-history.
 *  - EXPERITY/MedRite (no ehrPatientId): cross-EHR canonical model keyed by insurance
 *    member id. This is the fix — the base_athena path has no Experity data and used
 *    to crash on Experity's GUID context id. Member-keyed is coarser (subscriber may
 *    cover dependents), so it's only the fallback where no patient id is available.
 */
export async function gatherPatientHistory(dto: PricingRequestDto): Promise<{
  rows: Record<string, unknown>[];
  note: string;
}> {
  const serviceDate = toYmd(dto.serviceDate);
  if (dto.ehrPatientId) {
    const rows = await executeQuery(
      patientHistorySql({ serviceDate, orgId: dto.orgId, ehrPatientId: dto.ehrPatientId }),
    );
    return { rows, note: rows.length ? `${rows.length} prior closed-claim rows (Athena, patient-keyed)` : "no prior claims (new patient)" };
  }
  // No patient id -> Experity/MedRite: fall back to canonical, member-keyed.
  const memberId = dto.primaryInsurance?.memberId;
  if (!memberId) {
    return { rows: [], note: "no ehrPatientId or member id on DTO — patient history skipped" };
  }
  const rows = await executeQuery(CANONICAL_OWN_HISTORY_SQL, [serviceDate, memberId]);
  return { rows, note: rows.length ? `${rows.length} prior claim lines (canonical, member-keyed pnr)` : "no prior claims (new member)" };
}

/** Step 2: STEDI eligibility for all unique STCs + STC 30. */
export async function gatherStedi(
  dto: PricingRequestDto,
  payerStediId: string | null,
  uniqueStcs: string[],
  provider: { npi: string | null; firstName: string | null; lastName: string | null },
): Promise<{ results: Awaited<ReturnType<typeof checkEligibilityForStcs>>; groupNumber: string | null }> {
  if (!payerStediId) {
    return { results: [], groupNumber: dto.primaryInsurance.groupNumber ?? null };
  }
  const results = await checkEligibilityForStcs(
    {
      tradingPartnerServiceId: payerStediId,
      npi: provider.npi ?? undefined,
      providerFirstName: provider.firstName ?? undefined,
      providerLastName: provider.lastName ?? undefined,
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
    const stc30 = results.find((r) => r.ok && r.stc === "30");
    if (stc30 && stc30.ok) {
      const sub = (stc30.response.subscriber ?? {}) as Record<string, unknown>;
      groupNumber = (sub.groupNumber as string) ?? null;
    }
  }
  return { results, groupNumber };
}

/**
 * Step 3: group/plan intelligence (date-gated), capped in-memory to keep tokens sane.
 * Routed by EHR, mirroring own-history:
 *  - ATHENA (ehrPatientId present): base_athena, keyed by the group number resolved
 *    upstream from STEDI/DTO. UNCHANGED.
 *  - EXPERITY/MedRite (no ehrPatientId): the canonical member-id SATURATION query —
 *    Experity claims carry no group number and Experity STEDI doesn't return one, so
 *    we recover the group by joining on member id to coverage entities and self-resolve
 *    the pricing member's own group. Rows carry pnr (canonical shape).
 */
export async function gatherGroupIntelligence(
  dto: PricingRequestDto,
  groupNumber: string | null,
): Promise<{ rows: Record<string, unknown>[]; note: string }> {
  const serviceDate = toYmd(dto.serviceDate);

  // Athena: base-table group query, keyed by an upstream group number.
  if (dto.ehrPatientId) {
    if (!groupNumber) {
      return { rows: [], note: "no group number available — group intelligence skipped (Athena)" };
    }
    const rows = await executeQuery(groupIntelligenceSql({ serviceDate, orgId: dto.orgId, groupNumber }));
    const capped = rows.slice(0, 200);
    return {
      rows: capped,
      note:
        rows.length > capped.length
          ? `group ${groupNumber}: ${rows.length} rows, capped to ${capped.length} most-recent`
          : `group ${groupNumber}: ${rows.length} rows`,
    };
  }

  // Experity/MedRite: saturate Experity claims with a group via the coverage-entities
  // crosswalk and self-resolve the pricing member's group (canonical pnr shape).
  const memberId = dto.primaryInsurance?.memberId;
  if (!memberId) {
    return { rows: [], note: "no member id — group intelligence skipped (Experity)" };
  }
  const rows = await executeQuery(CANONICAL_GROUP_HISTORY_SQL, [serviceDate, memberId]);
  const capped = rows.slice(0, 200);
  return {
    rows: capped,
    note: rows.length
      ? `MedRite group (canonical member-saturated, pnr): ${rows.length} lines${rows.length > capped.length ? `, capped to ${capped.length}` : ""}`
      : "no group cohort — member's group not resolvable via coverage entities (or empty)",
  };
}
