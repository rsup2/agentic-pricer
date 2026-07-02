/**
 * The exact Snowflake queries from the agentic-pricer skill, ported verbatim.
 *
 * ⛔ FOREKNOWLEDGE GUARDS — these are load-bearing for correctness, not optional:
 *   - c.claimservicedate < :serviceDate            (strict <, never <=)
 *   - t.transactioncreateddatetime < :serviceDate  (only transactions that had
 *     already posted before the pricing moment)
 * Do NOT relax either guard. The current visit's claim and any not-yet-returned
 * transaction must never enter the result set. See agentic-pricer.md "NO FOREKNOWLEDGE".
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
 * Shared CTE body for the patient-history (1c) and group-intelligence (Step 3)
 * queries. They are identical except for the `whereFilter` line:
 *   - patient history:      AND c.patientid = :patientId
 *   - group intelligence:   AND pi1.policygroupnumber = :groupNumber
 *
 * Binds used by name: :serviceDate, :orgId, plus whatever whereFilter references.
 * (snowflake-sdk uses positional binds; we substitute named-looking tokens at
 *  build time in queries' callers — see history/group builders below which take
 *  literal-safe values. serviceDate/orgId/patientId/groupNumber are interpolated
 *  as validated primitives, NOT free text, by the callers in this file.)
 */
function buildHistoryStyleQuery(opts: {
  serviceDate: string; // YYYY-MM-DD, validated
  orgId: number;
  whereFilter: string; // already-safe filter line
}): string {
  const { serviceDate, orgId, whereFilter } = opts;
  return `
WITH master AS (
  SELECT cd.procedurecode,
         p.patientid,
         c.claimappointmentid,
         c.claimid,
         c.contextid context_id,
         c.claimservicedate,
         t.transfers, t.payments, t.outstanding, t.amount,
         t.transactiontype, t.transactiontransfertype, t.transactionreason,
         ip1.name primary_package,
         pi1.policyidnumber primary_memberid,
         ip2.name secondary_package,
         pi2.policyidnumber secondary_memberid,
         pi1.patientinsuranceid
  FROM claim c
  INNER JOIN patient p ON c.patientid = p.patientid AND c.contextid = p.contextid
  LEFT JOIN appointment a ON c.claimappointmentid = a.appointmentid AND a.contextid = c.contextid
  LEFT JOIN appointmenttype at ON a.appointmenttypeid = at.appointmenttypeid AND a.contextid = at.contextid
  LEFT JOIN patientinsurance pi1 ON c.claimprimarypatientinsid = pi1.patientinsuranceid AND c.contextid = pi1.contextid AND c.patientid = pi1.patientid
  LEFT JOIN patientinsurance pi2 ON c.claimsecondarypatientinsid = pi2.patientinsuranceid AND c.contextid = pi2.contextid AND c.patientid = pi2.patientid
  LEFT JOIN insurancepackage ip1 ON ip1.insurancepackageid = pi1.insurancepackageid AND ip1.contextid = pi1.contextid
  LEFT JOIN insurancepackage ip2 ON ip2.insurancepackageid = pi2.insurancepackageid AND ip2.contextid = pi2.contextid
  LEFT JOIN transaction t ON c.claimid = t.claimid AND c.contextid = t.contextid
  LEFT JOIN chargedetail cd ON t.parentchargeid = cd.chargeid AND t.contextid = cd.contextid
  -- Compare as strings: Experity orgs have GUID ehr_context_ids; an Athena claim's
  -- numeric contextid would otherwise force a numeric cast of the GUID and throw
  -- "Numeric value '<guid>' is not recognized". Casting avoids the crash — Athena
  -- still matches (numeric-as-string), Experity simply finds no Athena claims (empty).
  LEFT JOIN prod_core.base_hex_pricing.organization o ON o.ehr_context_id = TO_VARCHAR(c.contextid)
  WHERE c.claimservicedate >= DATEADD('year', -2, '${serviceDate}')
    AND c.claimservicedate < '${serviceDate}'
    AND t.transactioncreateddatetime < '${serviceDate}'   -- only transactions that had RETURNED/posted before pricing date
    AND o.org_id = ${orgId}
    ${whereFilter}
    AND t.voideddate IS NULL
    AND c.primaryclaimstatus = 'CLOSED'
    AND c.secondaryclaimstatus = 'CLOSED'
  ORDER BY a.appointmentdate DESC
),
codes AS (
  SELECT DISTINCT procedurecode, patientid, claimid, context_id, claimappointmentid,
                  claimservicedate, primary_memberid, primary_package,
                  secondary_memberid, secondary_package, patientinsuranceid
  FROM master
),
deductibles AS (
  SELECT DISTINCT procedurecode, patientid, claimappointmentid, claimservicedate, SUM(amount) deduct
  FROM master
  WHERE transactiontransfertype = 'Patient' AND transactionreason IN ('DEDUCTIBLE','DEDUCT')
    AND transactiontype IN ('TRANSFERIN','TRANSFEROUT')
  GROUP BY procedurecode, patientid, claimappointmentid, claimservicedate
),
coinsurances AS (
  SELECT DISTINCT procedurecode, patientid, claimappointmentid, claimservicedate, SUM(amount) coins
  FROM master
  WHERE transactiontransfertype = 'Patient' AND transactionreason = 'COINSURANCE'
    AND transactiontype IN ('TRANSFERIN','TRANSFEROUT')
  GROUP BY procedurecode, patientid, claimappointmentid, claimservicedate
),
copays AS (
  SELECT DISTINCT procedurecode, patientid, claimappointmentid, claimservicedate, SUM(amount) copay
  FROM master
  WHERE transactiontransfertype = 'Patient' AND transactionreason = 'COPAY'
    AND transactiontype IN ('TRANSFERIN','TRANSFEROUT')
  GROUP BY procedurecode, patientid, claimappointmentid, claimservicedate
),
allowable AS (
  SELECT DISTINCT procedurecode, patientid, claimappointmentid, claimservicedate, SUM(amount) allowable
  FROM master
  WHERE transactiontransfertype = 'Primary' AND transactiontype IN ('CHARGE','ADJUSTMENT')
  GROUP BY procedurecode, patientid, claimappointmentid, claimservicedate
),
payments AS (
  SELECT DISTINCT procedurecode, patientid, claimappointmentid, claimservicedate, SUM(-1 * amount) payment
  FROM master
  WHERE transactiontransfertype IN ('Primary','Secondary') AND transactiontype IN ('PAYMENT')
  GROUP BY procedurecode, patientid, claimappointmentid, claimservicedate
),
other AS (
  SELECT DISTINCT procedurecode, patientid, claimappointmentid, claimservicedate, SUM(amount) other
  FROM master
  WHERE transactiontransfertype = 'Patient'
    AND transactionreason NOT IN ('COPAY','COINSURANCE','DEDUCTIBLE','DEDUCT')
    AND transactiontype IN ('TRANSFERIN','TRANSFEROUT')
  GROUP BY procedurecode, patientid, claimappointmentid, claimservicedate
),
final AS (
  SELECT c.*, d.deduct, c1.coins, c2.copay, a.allowable, p.payment, o.other
  FROM codes c
  LEFT JOIN deductibles d ON c.procedurecode = d.procedurecode AND c.patientid = d.patientid AND c.claimappointmentid = d.claimappointmentid AND c.claimservicedate = d.claimservicedate
  LEFT JOIN coinsurances c1 ON c.procedurecode = c1.procedurecode AND c.patientid = c1.patientid AND c.claimappointmentid = c1.claimappointmentid AND c.claimservicedate = c1.claimservicedate
  LEFT JOIN copays c2 ON c.procedurecode = c2.procedurecode AND c.patientid = c2.patientid AND c.claimappointmentid = c2.claimappointmentid AND c.claimservicedate = c2.claimservicedate
  LEFT JOIN allowable a ON c.procedurecode = a.procedurecode AND c.patientid = a.patientid AND c.claimappointmentid = a.claimappointmentid AND c.claimservicedate = a.claimservicedate
  LEFT JOIN payments p ON c.procedurecode = p.procedurecode AND c.patientid = p.patientid AND c.claimappointmentid = p.claimappointmentid AND c.claimservicedate = p.claimservicedate
  LEFT JOIN other o ON c.procedurecode = o.procedurecode AND c.patientid = o.patientid AND c.claimappointmentid = o.claimappointmentid AND c.claimservicedate = o.claimservicedate
),
joined AS (
  SELECT f.*, et.incomingtransaction, et.eligibilitytrackid,
         ROW_NUMBER() OVER (
           PARTITION BY f.patientinsuranceid, f.claimservicedate, f.procedurecode
           ORDER BY et.createddatetime DESC NULLS LAST, et.eligibilitytrackid DESC
         ) AS rn
  FROM final f
  LEFT JOIN eligibilitytrack et
    ON et.contextid = f.context_id
   AND et.patientinsuranceid = f.patientinsuranceid
   AND SUBSTR(et.dateofservicedatetime, 1, 10) <= f.claimservicedate
   AND et.createddatetime < DATEADD('d', 30, f.claimservicedate)
   AND et.verificationnote LIKE '<b class=successtext%'
   AND et.incomingtransaction IS NOT NULL
),
plan_desc AS (
  SELECT eligibilitytrackid, contextid, MAX(plancoveragedesc) AS plancoveragedesc
  FROM eligibilitybenefit
  WHERE plancoveragedesc IS NOT NULL
  GROUP BY 1, 2
),
eb_agg AS (
  SELECT eligibilitytrackid, contextid,
    MAX(IFF(benefitinfo='C' AND coveragelevel='IND' AND timeperiodtype='25', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_deduct_total_preferred,
    MAX(IFF(benefitinfo='C' AND coveragelevel='IND' AND timeperiodtype='23', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_deduct_total_fallback,
    MAX(IFF(benefitinfo='C' AND coveragelevel='IND' AND timeperiodtype='22', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_deduct_total_fallback_2,
    MAX(IFF(benefitinfo='C' AND coveragelevel='IND' AND timeperiodtype='29', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_deduct_remaining,
    MAX(IFF(benefitinfo='C' AND coveragelevel='IND' AND timeperiodtype='24', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_deduct_met,
    MAX(IFF(benefitinfo='C' AND coveragelevel='FAM' AND timeperiodtype='25', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_deduct_total_preferred,
    MAX(IFF(benefitinfo='C' AND coveragelevel='FAM' AND timeperiodtype='23', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_deduct_total_fallback,
    MAX(IFF(benefitinfo='C' AND coveragelevel='FAM' AND timeperiodtype='22', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_deduct_total_fallback_2,
    MAX(IFF(benefitinfo='C' AND coveragelevel='FAM' AND timeperiodtype='29', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_deduct_remaining,
    MAX(IFF(benefitinfo='C' AND coveragelevel='FAM' AND timeperiodtype='24', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_deduct_met,
    MAX(IFF(benefitinfo='G' AND coveragelevel='IND' AND timeperiodtype='25', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_oop_total_preferred,
    MAX(IFF(benefitinfo='G' AND coveragelevel='IND' AND timeperiodtype='23', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_oop_total_fallback,
    MAX(IFF(benefitinfo='G' AND coveragelevel='IND' AND timeperiodtype='22', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_oop_total_fallback_2,
    MAX(IFF(benefitinfo='G' AND coveragelevel='IND' AND timeperiodtype='29', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_oop_remaining,
    MAX(IFF(benefitinfo='G' AND coveragelevel='IND' AND timeperiodtype='24', TRY_TO_NUMBER(monetaryamount), NULL)) AS ind_oop_met,
    MAX(IFF(benefitinfo='G' AND coveragelevel='FAM' AND timeperiodtype='25', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_oop_total_preferred,
    MAX(IFF(benefitinfo='G' AND coveragelevel='FAM' AND timeperiodtype='23', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_oop_total_fallback,
    MAX(IFF(benefitinfo='G' AND coveragelevel='FAM' AND timeperiodtype='22', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_oop_total_fallback_2,
    MAX(IFF(benefitinfo='G' AND coveragelevel='FAM' AND timeperiodtype='29', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_oop_remaining,
    MAX(IFF(benefitinfo='G' AND coveragelevel='FAM' AND timeperiodtype='24', TRY_TO_NUMBER(monetaryamount), NULL)) AS fam_oop_met
  FROM eligibilitybenefit
  WHERE servicetypecode = '30' AND benefitinfo IN ('C','G') AND plannetwork <> 'N'
    AND monetaryamount IS NOT NULL AND TRY_TO_NUMBER(monetaryamount) IS NOT NULL
    AND timeperiodtype IN ('22','23','24','25','29') AND coveragelevel IN ('IND','FAM')
  GROUP BY 1, 2
)
SELECT DISTINCT j.*,
  pd.plancoveragedesc,
  COALESCE(eb.ind_deduct_total_preferred, eb.ind_deduct_total_fallback, eb.ind_deduct_total_fallback_2) AS ind_deductible_total,
  eb.ind_deduct_remaining AS ind_deductible_remaining,
  eb.ind_deduct_met       AS ind_deductible_met,
  COALESCE(eb.fam_deduct_total_preferred, eb.fam_deduct_total_fallback, eb.fam_deduct_total_fallback_2) AS fam_deductible_total,
  eb.fam_deduct_remaining AS fam_deductible_remaining,
  eb.fam_deduct_met       AS fam_deductible_met,
  COALESCE(eb.ind_oop_total_preferred, eb.ind_oop_total_fallback, eb.ind_oop_total_fallback_2) AS ind_oop_max_total,
  eb.ind_oop_remaining AS ind_oop_max_remaining,
  eb.ind_oop_met       AS ind_oop_max_met,
  COALESCE(eb.fam_oop_total_preferred, eb.fam_oop_total_fallback, eb.fam_oop_total_fallback_2) AS fam_oop_max_total,
  eb.fam_oop_remaining AS fam_oop_max_remaining,
  eb.fam_oop_met       AS fam_oop_max_met
FROM joined j
LEFT JOIN eb_agg eb ON j.eligibilitytrackid = eb.eligibilitytrackid AND j.context_id = eb.contextid
LEFT JOIN plan_desc pd ON j.eligibilitytrackid = pd.eligibilitytrackid AND j.context_id = pd.contextid
WHERE j.rn = 1
  AND allowable > 0
  AND other IS NULL
`;
}

/**
 * 1c — patient's OWN prior claims (own prior closed claims, date-gated), keyed by
 * the EHR patient id via the base_athena claim/transaction tables. This is the
 * ATHENA path and is UNCHANGED — it mirrors how AIR keys own-history (patient-first;
 * member id is only used to pick primary vs secondary insurance), so it stays
 * patient-specific. Used whenever the request carries an ehrPatientId (Athena).
 */
export function patientHistorySql(opts: {
  serviceDate: string;
  orgId: number;
  ehrPatientId: string;
}): string {
  const safePatientId = String(opts.ehrPatientId).replace(/'/g, '');
  return buildHistoryStyleQuery({
    serviceDate: opts.serviceDate,
    orgId: opts.orgId,
    whereFilter: `AND c.patientid = '${safePatientId}'`,
  });
}

/**
 * 1c (Experity/MedRite fallback) — own prior claims from the cross-EHR canonical
 * model (prod_core.canonical.claims), keyed by insurance MEMBER id. Used ONLY when
 * the request has no ehrPatientId (Experity DTOs don't carry one) — the base_athena
 * path above has no Experity data and coerced Experity's GUID context id to a number
 * ("Numeric value '<guid>' is not recognized"). Carries the already-adjudicated
 * patient responsibility (pnr); point lookup, not the heavy multi-join.
 *
 * Member-keyed is coarser than patient-keyed (a subscriber id can cover dependents),
 * so it is deliberately the FALLBACK, not the default — Athena keeps patient-keying.
 *
 * Bind params (positional, like PAYER_LOOKUP_SQL): :1 = serviceDate (YYYY-MM-DD),
 * :2 = memberId. Parameterized rather than interpolated — this reads PHI claims and
 * memberId is user-supplied. Caller: executeQuery(CANONICAL_OWN_HISTORY_SQL, [serviceDate, memberId]).
 *
 * ⛔ FOREKNOWLEDGE: date_of_service strictly < serviceDate; 2-year lookback bounds
 * volume. The settled pnr subsumes the base_athena transaction-posting-date guard.
 */
export const CANONICAL_OWN_HISTORY_SQL = `
SELECT source_system, procedure_code, modifier, date_of_service,
       pnr, payment, list_price,
       payer_plan_name, payer_type, plan_type,
       insurance_member_id, insurance_group_number, state
FROM prod_core.canonical.claims
WHERE pnr IS NOT NULL
  AND date_of_service < TO_DATE(:1)
  AND date_of_service >= DATEADD('year', -2, TO_DATE(:1))
  AND insurance_member_id = :2
ORDER BY date_of_service DESC
LIMIT 400
`;

/**
 * Step 3 (Experity/MedRite) — GROUP historicals via member-id SATURATION. Experity
 * claims carry NO group number (~0% across every source), so the base_athena group
 * query returns nothing. Instead we saturate: join each Experity claim on insurance
 * member id to a coverage entity we've already produced (RAW_AIR_MONGO.COVERAGE_ENTITIES),
 * stamping the group number onto the claim, then return everyone sharing the PRICING
 * member's group. The pricing member's own group is resolved from the same crosswalk
 * (target_group) — Experity STEDI doesn't return it. Carries pnr (adjudicated patient
 * responsibility), same shape as CANONICAL_OWN_HISTORY_SQL.
 *
 * Coverage today ~14% of MedRite claim lines (grows as we price more members); big
 * cohorts are real multi-member employer/plan groups. Live-query latency ~4.5s —
 * acceptable for the async shadow; the prod path should be a DBT-precomputed
 * (group x CPT) frequency table (see sql/experity_group_historicals.sql).
 *
 * Bind params: :1 = serviceDate (YYYY-MM-DD, used twice), :2 = pricing memberId.
 * Caller: executeQuery(CANONICAL_GROUP_HISTORY_SQL, [serviceDate, memberId]).
 * ⛔ FOREKNOWLEDGE: date_of_service strictly < serviceDate; 2-year lookback.
 */
export const CANONICAL_GROUP_HISTORY_SQL = `
WITH member_group AS (
  SELECT TRIM(memberid) AS member_id,
         MAX(COALESCE(
           coverage:plans[0]:groupNumber::string,
           coverage:planInformation:groupNumber::string,
           coverage:PlanCoverageSummary:GroupNumber::string
         )) AS group_number
  FROM prod_raw.raw_air_mongo.coverage_entities
  WHERE COALESCE(
           coverage:plans[0]:groupNumber::string,
           coverage:planInformation:groupNumber::string,
           coverage:PlanCoverageSummary:GroupNumber::string
        ) IS NOT NULL
  GROUP BY 1
),
target_group AS (
  SELECT group_number FROM member_group WHERE member_id = TRIM(:2)
),
saturated AS (
  SELECT c.source_system, c.procedure_code, c.modifier, c.date_of_service,
         c.pnr, c.payment, c.list_price, c.payer_plan_name, c.payer_type,
         c.plan_type, c.state, mg.group_number
  FROM prod_core.canonical.claims c
  JOIN member_group mg ON TRIM(c.insurance_member_id) = mg.member_id
  WHERE c.source_system = 'EXPERITY'
    AND c.pnr IS NOT NULL
    AND c.date_of_service <  TO_DATE(:1)
    AND c.date_of_service >= DATEADD('year', -2, TO_DATE(:1))
)
SELECT s.source_system, s.procedure_code, s.modifier, s.date_of_service,
       s.pnr, s.payment, s.list_price, s.payer_plan_name, s.payer_type,
       s.plan_type, s.state, s.group_number
FROM saturated s
JOIN target_group t ON s.group_number = t.group_number
ORDER BY s.date_of_service DESC
LIMIT 400
`;

/** Step 3 — group/plan intelligence (all members on a group number, date-gated). */
export function groupIntelligenceSql(opts: {
  serviceDate: string;
  orgId: number;
  groupNumber: string;
}): string {
  const safeGroup = String(opts.groupNumber).replace(/'/g, '');
  return buildHistoryStyleQuery({
    serviceDate: opts.serviceDate,
    orgId: opts.orgId,
    whereFilter: `AND pi1.policygroupnumber = '${safeGroup}'`,
  });
}

/** Build a comma-separated numeric list for an IN (...) clause from numbers. */
export function buildNumericInList(ids: number[]): string {
  return ids
    .filter((n) => Number.isFinite(n))
    .map((n) => String(Math.trunc(n)))
    .join(', ');
}
