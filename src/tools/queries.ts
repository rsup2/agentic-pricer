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

/** 1a — payer Stedi id lookup. */
export const PAYER_LOOKUP_SQL = `
SELECT stedi_payer_id, name
FROM prod_core.base_hex_pricing.payers
WHERE LOWER(name) ILIKE LOWER(:1)
LIMIT 5
`;

/** 1b — SRT -> STC map. :1 is a parenthesised list bind via buildInList(). */
export function stcLookupSql(srtIdList: string): string {
  return `
SELECT srt_id, primary_service_type_code, secondary_service_type_code
FROM prod_core.base_hex_pricing.srt
WHERE srt_id IN (${srtIdList})
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
  LEFT JOIN prod_core.base_hex_pricing.organization o ON o.ehr_context_id = c.contextid
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

/** 1c — patient claim history (own prior closed claims, date-gated). */
export function patientHistorySql(opts: {
  serviceDate: string;
  orgId: number;
  ehrPatientId: string;
}): string {
  // ehrPatientId/orgId/serviceDate validated as primitives by the caller.
  const safePatientId = String(opts.ehrPatientId).replace(/'/g, '');
  return buildHistoryStyleQuery({
    serviceDate: opts.serviceDate,
    orgId: opts.orgId,
    whereFilter: `AND c.patientid = '${safePatientId}'`,
  });
}

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
