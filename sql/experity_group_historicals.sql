-- MedRite / Experity GROUP historicals via member-id saturation.
--
-- PROBLEM: Experity/MedRite (org 24 — the only Experity org) claims carry NO usable
-- insurance group number. Measured across every candidate source:
--   canonical.claims (EXPERITY)      674,747 rows  0.00% group populated
--   base_experity.grouped_claims     337,590 rows  0.00%
--   base_experity.transaction_claims 4.39M rows    ~0.0002%
-- So the existing base_athena group-intelligence query (policygroupnumber) returns
-- nothing for MedRite. The Athena path is UNCHANGED and still correct for Athena orgs.
--
-- APPROACH (per product owner): "saturate" each claim with a group number by joining
-- on insurance MEMBER ID to a coverage entity we've already produced — if we've ever
-- run coverage for that member, the group number is in RAW_AIR_MONGO.COVERAGE_ENTITIES.
-- Then group-by that derived group number to build the group-historical cohort.
--
-- FEASIBILITY (validated on PROD, aggregate-only, 2026-07-01):
--   * Best join target: RAW_AIR_MONGO.COVERAGE_ENTITIES (only source with BOTH a
--     member-id key and a well-populated group number — 66% of coverage rows carry one).
--   * Coverage today: ~10.5% of distinct MedRite claim members, ~13.8% of claim LINES,
--     ~14.1% of appointments. Ceiling is member OVERLAP (only ~12.7% of MedRite claim
--     members have ever had coverage run), not group fill — it grows as we price more.
--   * Cohort payoff is strong: of saturated lines, 63.4% fall in a group with >= 20
--     lines and 41.2% in a group with >= 100 lines. Big groups are genuine multi-member
--     employer/plan cohorts (largest: 456 distinct members / 3,533 lines; top 15 groups
--     each span 130-600 members) — validates the "same employer near the clinic" thesis.
--   * So: this yields usable group cohorts for the ~14% of MedRite claims we can saturate
--     today; the other ~86% get no group signal (fall back to own-history + eligibility).
--
-- ⛔ FOREKNOWLEDGE: date_of_service strictly < :serviceDate, 2-year lookback. The
-- current visit's claim can never enter the cohort.
--
-- ⚠️ PRODUCTIONIZATION (the right home — see boss's roadmap): this live query joins
-- 3.5M coverage_entities against 647K Experity claim lines on EVERY pricing call, which
-- fights the latency/cost gates. Precompute it in DBT (talk to Lan; mirror his existing
-- AIR group pre-clustering model):
--   Option A — member->group CROSSWALK: one small table {member_id, group_number,
--     as_of} materialized from coverage_entities (dedupe latest per member). AP joins
--     canonical.claims to it at query time. Smallest, most flexible.
--   Option B — fully saturated GROUP x CPT FREQUENCY table: precompute, per
--     (group_number, procedure_code), the patientResp distribution (n, zeroRate, median,
--     mode, p25/p75) — i.e. the exact shape src/pricing/history-encoding.ts emits, but
--     materialized. AP does a point lookup by (group_number, cpt). This is the ideal:
--     it converges MedRite-group + DBT-precompute + frequency-table into ONE model and
--     drops both context cost and latency to a lookup.
-- Recommend Option B for the group path, keeping Option A's crosswalk as its input.
--
-- The query below is the live/prototype form (Option A inlined) used to validate the
-- approach and as an AP fallback until the DBT model lands. Binds: :1 = serviceDate
-- (YYYY-MM-DD), :2 = pricing member id. Read-only.

WITH member_group AS (
  -- member -> group crosswalk from coverage entities. One group per member = the group
  -- from the member's MOST RECENT coverage record (by source-modified time), NOT a
  -- lexicographic MAX — so a plan change / secondary insurance can't silently win.
  -- Group number lives at one of three JSON paths (Change/Stedi vs pVerify shapes).
  -- (DBT Option A should materialize this crosswalk with an explicit as_of.)
  SELECT member_id, group_number FROM (
    SELECT TRIM(memberid) AS member_id,
           COALESCE(
             coverage:plans[0]:groupNumber::string,
             coverage:planInformation:groupNumber::string,
             coverage:PlanCoverageSummary:GroupNumber::string
           ) AS group_number,
           ROW_NUMBER() OVER (
             PARTITION BY TRIM(memberid)
             ORDER BY __HEVO__SOURCE_MODIFIED_AT DESC NULLS LAST
           ) AS rn
    FROM prod_raw.raw_air_mongo.coverage_entities
    WHERE COALESCE(
             coverage:plans[0]:groupNumber::string,
             coverage:planInformation:groupNumber::string,
             coverage:PlanCoverageSummary:GroupNumber::string
          ) IS NOT NULL
  )
  WHERE rn = 1
),
target_group AS (
  -- the group number for the member being priced (fallback when STEDI/DTO didn't give one)
  SELECT group_number FROM member_group WHERE member_id = TRIM(:2)
),
saturated AS (
  -- every prior Experity claim line, enriched with its member's group number
  SELECT c.procedure_code, c.modifier, c.date_of_service,
         c.pnr, c.payment, c.list_price,
         c.payer_plan_name, c.payer_type, c.plan_type, c.state,
         mg.group_number
  FROM prod_core.canonical.claims c
  JOIN member_group mg ON TRIM(c.insurance_member_id) = mg.member_id
  WHERE c.source_system = 'EXPERITY'
    AND c.pnr IS NOT NULL
    AND TRIM(c.insurance_member_id) <> TRIM(:2)   -- exclude the pricing member (own-history covers them; keeps the group signal independent)
    AND c.date_of_service <  TO_DATE(:1)
    AND c.date_of_service >= DATEADD('year', -2, TO_DATE(:1))
)
SELECT s.procedure_code, s.modifier, s.date_of_service,
       s.pnr, s.payment, s.list_price,
       s.payer_plan_name, s.payer_type, s.plan_type, s.state, s.group_number
FROM saturated s
JOIN target_group t ON s.group_number = t.group_number
ORDER BY s.date_of_service DESC
LIMIT 400;
