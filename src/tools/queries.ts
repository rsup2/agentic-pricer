/**
 * The exact Snowflake queries from the agentic-pricer skill, ported verbatim.
 *
 * ⛔ FOREKNOWLEDGE GUARD — load-bearing for correctness, not optional:
 *   - date_of_service < :serviceDate   (strict <, never <=)
 * Do NOT relax it. The visit being priced, and any claim after it, must never
 * enter the result set. See agentic-pricer.md "NO FOREKNOWLEDGE". (Claim history
 * now comes from the canonical model, which carries already-adjudicated PNR, so
 * the prior transaction-posting-date guard is subsumed by the service-date gate.)
 *
 * serviceDate is passed as a YYYY-MM-DD string bind. All queries are read-only.
 */

/**
 * 1a — payer id lookup. `availity_payer_code` is a comma-separated list of payer
 * ids to try in sequence (see gather.ts, which probes each against Stedi). The
 * value is a string and may carry leading zeros — never coerce it to a number.
 */
export const PAYER_LOOKUP_SQL = `
SELECT availity_payer_code, payer_name
FROM prod_core.base_hex_pricing.payer
WHERE LOWER(payer_name) ILIKE LOWER(:1)
LIMIT 5
`;

/**
 * 1a' — default provider for an org. Stedi requires BOTH a provider id (NPI) and
 * a name (organizationName or lastName); an NPI alone is rejected. When the
 * request DTO omits the provider, we fall back to the org's billing provider:
 * default_provider gives the NPI, joined to provider (on npi) for the last name.
 * An org may have several rows (per state/practice); the caller prefers a STATE
 * match, else the first row. :1 = org_id.
 */
export const DEFAULT_PROVIDER_SQL = `
SELECT dp.npi, dp.state, p.first_name, p.last_name
FROM prod_core.base_hex_pricing.default_provider dp
LEFT JOIN prod_core.base_hex_pricing.provider p ON p.npi = dp.npi
WHERE dp.org_id = :1 AND dp.npi IS NOT NULL
`;

/**
 * Provider name by NPI. Used to backfill the provider FIRST name (and last, if
 * the DTO omitted it) when the request supplies an NPI but no first name — Stedi
 * rejects an NPI-1 person loop lacking a first name with AAA-44. :1 = npi.
 */
export const PROVIDER_BY_NPI_SQL = `
SELECT npi, first_name, last_name
FROM prod_core.base_hex_pricing.provider
WHERE npi = :1
LIMIT 1
`;

/** 1b — SRT -> STC map. :1 is a parenthesised list bind via buildInList(). */
export function stcLookupSql(srtIdList: string): string {
  return `
SELECT srt_id, primary_service_type, secondary_service_type
FROM prod_core.base_hex_pricing.srt
WHERE srt_id IN (${srtIdList})
`;
}

/**
 * 1b' — human-readable procedure context per SRT: the SRT name/description,
 * place-of-service, specialist flag, and the actual billing (CPT/HCPCS) codes
 * with their descriptions and surgical signals (code_group/category/RVU/global
 * days). This is what lets the synthesis agent tell a knee arthroplasty (CPT
 * 27447, "Surgery", 90 global days) apart from a $20 office visit — without it,
 * the model free-associates the bare STC code. One row per (srt, billing_code);
 * SRTs with multiple CPTs produce multiple rows. NOTE: HRT_FLAGS is intentionally
 * NOT joined here — that table is not trustworthy as a benefit-class signal.
 */
export function srtContextSql(srtIdList: string): string {
  return `
SELECT s.srt_id, s.srt_name, s.srt_description, s.pos_code, s.is_specialist,
       s.tertiary_service_type,
       b.billing_code, b.code_group, b.category, b.description AS billing_description,
       b.rvu, b.global_days
FROM prod_core.base_hex_pricing.srt s
LEFT JOIN prod_core.base_hex_pricing.srt_to_billing_code sb ON sb.srt_id = s.srt_id
LEFT JOIN prod_core.base_hex_pricing.billing_code b ON b.billing_code = sb.billing_code
WHERE s.srt_id IN (${srtIdList})
`;
}


/**
 * Cross-EHR claim history from the precomputed canonical model
 * (prod_core.canonical.claims; SOURCE_SYSTEM = athena | experity). One row per
 * historical claim line with the already-adjudicated patient responsibility
 * (PNR) plus procedure + plan context. Works for BOTH Athena and Experity
 * (MedRite) orgs — the old base_athena join did neither: it had no Experity data
 * and crashed on Experity's GUID context ids ("Numeric value '<guid>' is not
 * recognized"). Being a DBT model, this is a point lookup, not the old ~13s join.
 *
 * ⛔ FOREKNOWLEDGE: date_of_service strictly < serviceDate (never the visit being
 * priced or anything after it); 2-year lookback bounds volume. memberId /
 * groupNumber are interpolated as quote-stripped literals by the callers below.
 */
function canonicalClaimsSql(opts: { serviceDate: string; whereFilter: string }): string {
  const { serviceDate, whereFilter } = opts;
  return `
SELECT source_system, procedure_code, modifier, date_of_service,
       pnr, payment, list_price,
       payer_plan_name, payer_type, plan_type,
       insurance_member_id, insurance_group_number, state
FROM prod_core.canonical.claims
WHERE pnr IS NOT NULL
  AND date_of_service < '${serviceDate}'
  AND date_of_service >= DATEADD('year', -2, '${serviceDate}')
  ${whereFilter}
ORDER BY date_of_service DESC
LIMIT 400
`;
}

/** 1c — patient's OWN prior claims, keyed by insurance member id (cross-EHR). */
export function patientHistorySql(opts: { serviceDate: string; memberId: string }): string {
  const safeMember = String(opts.memberId).replace(/'/g, '');
  return canonicalClaimsSql({
    serviceDate: opts.serviceDate,
    whereFilter: `AND insurance_member_id = '${safeMember}'`,
  });
}

/** Step 3 — group/plan intelligence (all members on a group number, date-gated). */
export function groupIntelligenceSql(opts: { serviceDate: string; groupNumber: string }): string {
  const safeGroup = String(opts.groupNumber).replace(/'/g, '');
  return canonicalClaimsSql({
    serviceDate: opts.serviceDate,
    whereFilter: `AND insurance_group_number = '${safeGroup}'`,
  });
}

/** Build a comma-separated numeric list for an IN (...) clause from numbers. */
export function buildNumericInList(ids: number[]): string {
  return ids
    .filter((n) => Number.isFinite(n))
    .map((n) => String(Math.trunc(n)))
    .join(', ');
}
