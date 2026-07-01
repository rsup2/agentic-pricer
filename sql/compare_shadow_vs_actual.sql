-- Shadow (agentic) vs. AIR vs. actual-claim comparison, reweighted to real traffic.
--
-- Evaluation path per Alex (Jun 29 "Alex <> Dhruv: Agentic AIR"):
--   1. On a fraction of prod AIR calls, branch and call the agentic pricer; save its
--      predicted price keyed by REQUEST_ID + SRT (done — AGENTIC_PRICER_RESULTS).
--   2. When the claim comes back (~2 weeks), use the EXISTING joins to line the
--      returned claim up with the price entity and the priced treatment, then compare
--      the agentic predicted price against the actual price on the returned claim.
--
-- The chain mirrors the dbt model `consolidated_cross.pricing_observability`.
-- `priced_treatment` is the anchor: it carries REQUEST_ID (our join key), `price`
-- (AIR's predicted price), and links forward to the bought treatment, slot, and ART
-- claim. So AIR's price + the actual adjudicated responsibility are both already in
-- Snowflake, keyed off REQUEST_ID — no Mongo lookup needed.
--
-- Chain:  priced_treatment ─(priced_treatment_id)→ bought_treatment ─(slot_id)→ slot
--           ─(ehr_slot_id)→ ehr_slot ─(ehr_visit_id = visit_id)→ art_claim
--         art_claim.total_adjudicated_responsibility = actual patient responsibility.
--
-- VERIFIED against PROD (read-only) on 2026-06-30:
--   tables: PROD_CORE.base_hex_pricing.priced_treatment, PROD_CORE.base_hex_pc.
--           {bought_treatment, slot, ehr_slot, art_claim}; all join columns present.
--           The full chain compiled + ran live (14 matches against the earlier
--           PLAYGROUND.MISC results set, since migrated to ALE.ALE_DEV).
--   priced_treatment AND art_claim both have duplicate keys in prod (re-pricing
--           attempts / multiple claims per visit) — hence the dedupe below; without
--           it the weighted aggregates double-count.
--   art_claim_status (prod): NOT_RELEVANT, TRANSFERRED, UNMATCHED, NO_ACTION,
--           PARTIAL_TRANSFER, SELF_PAY, ADJUSTED, RERUN_NEEDED, MANUAL_REVIEW,
--           PARTIAL_TRANSFER_INCREMENTAL_COLLECTION, CANCELLED, NOT_COLLECTED, ...
--           Comparable/terminal = TRANSFERRED + ADJUSTED (settled). See TODO at the
--           claim CTE — Alex to confirm whether PARTIAL_TRANSFER* should count.
--
-- EVERYTHING IS PROD: shadow results live in ALE.ALE_DEV.AGENTIC_PRICER_RESULTS
-- (matches env.ts defaults), joined to PROD_CORE. Run under a role that can read BOTH
-- ALE and PROD_CORE (ACCOUNTADMIN works; FR_CORE_READONLY does NOT — it can't see
-- ALE). Assumes both DBs are in the same Snowflake account.
--
-- GRAIN: our estimate is per-SRT; priced_treatment.price is per-treatment (HRT);
-- art_claim is per-claim/visit. We roll the shadow estimate up to HRT (matches
-- priced_treatment) and compare to the claim total — exact when one claim = one
-- treatment. For multi-treatment visits use ART CPT-line data (see note at bottom).
--
-- REQUEST_ID PROVENANCE: reliable for requests that arrived with the gateway's
-- REQUEST_ID (prod traffic). AIR backfills a uuid only when none was supplied; those
-- don't match priced_treatment.request_id and simply don't join.
--
-- SIMS (Alex's caveat): comparing against already-run sims gives an earlier signal
-- but risks foreknowledge contamination. Live claims (this query) are the clean
-- ground truth; treat any sim-based number as indicative only.

WITH shadow AS (
    -- roll our per-SRT estimates up to the treatment (HRT) grain.
    SELECT
        REQUEST_ID,
        HRT_ID,
        SUM(ESTIMATED_PATIENT_RESP)                   AS shadow_price,
        -- worst-case confidence across the treatment's SRTs
        MIN(CASE CONFIDENCE
                WHEN 'HIGH' THEN 3 WHEN 'MEDIUM' THEN 2
                WHEN 'LOW' THEN 1 ELSE 0 END)         AS shadow_conf_rank,
        ANY_VALUE(SAMPLING_REASON)                    AS sampling_reason,
        ANY_VALUE(SAMPLING_STRATUM)                   AS stratum,
        COALESCE(ANY_VALUE(INCLUSION_PROBABILITY), 1) AS p,   -- weight = 1/p
        ANY_VALUE(PRICER_VERSION)                     AS pricer_version, -- which build produced this (commit SHA)
        BOOLOR_AGG(CONFIDENCE = 'UNABLE_TO_PRICE')    AS any_unpriced
    FROM ALE.ALE_DEV.AGENTIC_PRICER_RESULTS
    WHERE STATUS = 'COMPLETED'
    GROUP BY REQUEST_ID, HRT_ID
),

-- AIR's predicted price, ONE row per (request_id, hrt_id): priced_treatment has
-- duplicate rows from re-pricing attempts (verified), so take the latest.
air AS (
    SELECT request_id, hrt_id, priced_treatment_id, price AS air_price
    FROM PROD_CORE.base_hex_pricing.priced_treatment
    WHERE request_id IS NOT NULL AND hrt_id IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY request_id, hrt_id ORDER BY created_at DESC
    ) = 1
),

-- The adjudicated claim, ONE row per (visit_id, org_id), restricted to terminal
-- statuses so we never compare against a still-in-flight responsibility.
-- TODO(alex): confirm the terminal set against the prod vocab. TRANSFERRED (240k) +
-- ADJUSTED (4k) are settled. EXCLUDED: NOT_RELEVANT/UNMATCHED/NO_ACTION/CANCELLED/
-- NOT_COLLECTED (no comparable adjudication), RERUN_NEEDED/MANUAL_REVIEW (not final),
-- SELF_PAY (no insurance adjudication). OPEN QUESTION: should PARTIAL_TRANSFER and
-- PARTIAL_TRANSFER_INCREMENTAL_COLLECTION count? They carry a responsibility but may
-- not be final — left OUT for now (conservative).
claim AS (
    SELECT visit_id, org_id, claim_id, art_claim_status,
           total_adjudicated_responsibility
    FROM PROD_CORE.base_hex_pc.art_claim
    WHERE art_claim_status IN ('TRANSFERRED', 'ADJUSTED')
      AND total_adjudicated_responsibility IS NOT NULL
    QUALIFY ROW_NUMBER() OVER (
        PARTITION BY visit_id, org_id ORDER BY created_at DESC
    ) = 1
),

joined AS (
    SELECT
        s.REQUEST_ID,
        s.HRT_ID,
        s.stratum,
        s.sampling_reason,
        s.pricer_version,
        s.p,
        s.shadow_conf_rank,
        s.shadow_price,
        a.air_price,                                              -- AIR's prediction
        c.total_adjudicated_responsibility AS actual_pr,          -- ground truth
        c.claim_id,
        c.art_claim_status,
        (s.shadow_price - c.total_adjudicated_responsibility) AS shadow_err, -- + over / - UNDERprice (costly)
        (a.air_price    - c.total_adjudicated_responsibility) AS air_err
    FROM shadow s
    JOIN air a
      ON a.request_id = s.REQUEST_ID
     AND a.hrt_id     = s.HRT_ID
    JOIN PROD_CORE.base_hex_pc.bought_treatment bt ON bt.priced_treatment_id = a.priced_treatment_id
    JOIN PROD_CORE.base_hex_pc.slot             sl ON sl.slot_id             = bt.slot_id
    JOIN PROD_CORE.base_hex_pc.ehr_slot         es ON es.ehr_slot_id         = sl.ehr_slot_id
    JOIN claim                                 c  ON c.visit_id::varchar    = es.ehr_visit_id::varchar
                                                 AND c.org_id::varchar      = es.org_id::varchar
    WHERE s.shadow_price IS NOT NULL
      AND NOT s.any_unpriced                                    -- only treatments the agent actually priced
)

-- Population-level, inclusion-probability-weighted scorecard, sliced by BUILD
-- (pricer_version = commit SHA) x confidence — so you compare version-over-version
-- and never pool prices from two code cuts. Filter `WHERE pricer_version = '<sha>'`
-- to score one build in isolation; map the SHA to its PR via PRICER_COMMIT_URL.
SELECT
    pricer_version,
    CASE shadow_conf_rank WHEN 3 THEN 'HIGH' WHEN 2 THEN 'MEDIUM'
                          WHEN 1 THEN 'LOW' ELSE 'NONE' END     AS shadow_confidence,
    COUNT(*)                                                    AS n_sampled,
    ROUND(SUM(1.0 / p))                                         AS est_population_n,
    -- weighted mean ABSOLUTE error
    ROUND(SUM(ABS(shadow_err) / p) / SUM(1.0 / p), 2)           AS shadow_wmae,
    ROUND(SUM(ABS(air_err)    / p) / SUM(1.0 / p), 2)           AS air_wmae,
    -- weighted mean SIGNED error (negative => systematic UNDERpricing, the costly mode)
    ROUND(SUM(shadow_err / p) / SUM(1.0 / p), 2)                AS shadow_bias,
    ROUND(SUM(air_err    / p) / SUM(1.0 / p), 2)                AS air_bias,
    -- underpricing rate (Superscript eats this), weighted to the population
    ROUND(SUM(IFF(shadow_err < 0, 1.0, 0) / p) / SUM(1.0 / p), 3) AS shadow_underprice_rate,
    ROUND(SUM(IFF(air_err    < 0, 1.0, 0) / p) / SUM(1.0 / p), 3) AS air_underprice_rate
FROM joined
GROUP BY pricer_version, shadow_conf_rank
ORDER BY pricer_version, shadow_conf_rank DESC;

-- ── $0 vs non-$0 SEGMENTATION (don't let full-coverage $0 matches flatter the score) ──
-- Objective-function caveat (Alex): a $0 prediction that matches a $0 claim scores as
-- "accurate" but creates ~no value — Medicaid/D-SNP/preventive orgs are full of these.
-- Segment by whether the ACTUAL responsibility was $0, expose how hard shadow leans on
-- $0, and add a head-to-head "moved toward truth vs AIR" win rate. The actual_>$0 segment
-- is where real value is proven; a great shadow_wmae there (not on the $0 rows) is the win.
SELECT
    pricer_version,
    CASE WHEN actual_pr = 0 THEN 'actual_$0 (low-info)'
         ELSE 'actual_>$0 (informative)' END                       AS segment,
    COUNT(*)                                                        AS n_sampled,
    ROUND(SUM(1.0 / p))                                            AS est_population_n,
    ROUND(SUM(ABS(shadow_err) / p) / SUM(1.0 / p), 2)              AS shadow_wmae,
    ROUND(SUM(ABS(air_err)    / p) / SUM(1.0 / p), 2)              AS air_wmae,
    -- how much shadow leans on predicting $0 within the segment
    ROUND(SUM(IFF(shadow_price = 0, 1.0, 0) / p) / SUM(1.0 / p), 3) AS shadow_pred_zero_rate,
    -- head-to-head value: shadow strictly closer to truth than AIR (weighted)
    ROUND(SUM(IFF(ABS(shadow_err) < ABS(air_err), 1.0, 0) / p) / SUM(1.0 / p), 3) AS shadow_beats_air_rate,
    ROUND(SUM(IFF(ABS(air_err) < ABS(shadow_err), 1.0, 0) / p) / SUM(1.0 / p), 3) AS air_beats_shadow_rate
FROM joined
GROUP BY pricer_version, segment
ORDER BY pricer_version, segment;

-- ── Per-SRT / per-CPT variant (finer grain, for multi-treatment visits) ─────────
-- Replace the claim-level actual with ART's CPT-line responsibility and join on the
-- SRT's billing code instead of rolling up to HRT:
--   ... JOIN PROD_CORE.base_hex_pricing.srt_to_billing_code sb ON sb.srt_id = r.SRT_ID
--       JOIN <art_claim_cpt_line> cl ON cl.claim_id = c.claim_id AND cl.procedure_code = sb.billing_code
--   compare r.ESTIMATED_PATIENT_RESP (per SRT) against cl.adjudicated_patient_responsibility.
-- Use when one visit bundles several treatments and the claim total can't be split.
