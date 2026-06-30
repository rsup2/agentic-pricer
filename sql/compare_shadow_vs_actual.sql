-- Shadow (agentic) vs. AIR vs. actual-claim comparison, reweighted to real traffic.
--
-- Evaluation path per Alex (Jun 29 "Alex <> Dhruv: Agentic AIR"):
--   1. On a fraction of prod AIR calls, branch and call the agentic pricer; save its
--      predicted price keyed by REQUEST_ID + SRT (done — AGENTIC_PRICER_RESULTS).
--   2. When the claim comes back (~2 weeks), use the EXISTING joins to line the
--      returned claim up with the price entity and the priced treatment, then compare
--      the agentic predicted price against the actual price on the returned claim.
--
-- That existing chain is the dbt model `consolidated_cross.pricing_observability`.
-- `priced_treatment` is the anchor: it carries REQUEST_ID (our exact join key),
-- `price` (AIR's predicted price), `pricing_entity_id` (per-SRT), and links forward
-- to the bought treatment, slot, and ART claim. So AIR's price + the actual
-- adjudicated responsibility are BOTH already in Snowflake, keyed off REQUEST_ID —
-- no Mongo lookup needed.
--
-- Chain (lifted from pricing_observability, minus its sim_results anchor):
--   priced_treatment ─(priced_treatment_id)→ bought_treatment ─(slot_id)→ slot
--     ─(ehr_slot_id)→ ehr_slot ─(ehr_visit_id = visit_id)→ art_claim
--   art_claim.total_adjudicated_responsibility  =  the actual patient responsibility.
--
-- ── GRAIN ─────────────────────────────────────────────────────────────────────
-- Our estimate is per-SRT; priced_treatment.price is per-treatment (HRT);
-- art_claim.total_adjudicated_responsibility is per-claim/visit. This query rolls
-- the shadow estimate up to the HRT grain so it matches priced_treatment cleanly,
-- and compares against the claim total — EXACT when one claim = one treatment (the
-- common case). For multi-treatment visits, attribute per-SRT/CPT using ART's
-- CPT-line data instead of the claim total (see the per-CPT note at the bottom).
--
-- ── REQUEST_ID PROVENANCE ───────────────────────────────────────────────────────
-- This join is reliable for requests that arrived with the gateway's REQUEST_ID
-- (production traffic). AIR backfills a uuid only when none was supplied; those
-- won't match priced_treatment.request_id (the gateway's), so they simply don't
-- join — acceptable, since prod gateway calls always carry a request id.
--
-- ── SIMS (Alex's caveat) ──────────────────────────────────────────────────────
-- You can get an earlier signal by comparing against already-run sims instead of
-- waiting for live claims, BUT Alex flagged foreknowledge contamination: if the
-- exact claim ground truth already exists, the agent may surface/use it despite
-- instructions. Live claims (this query) are the contamination-free ground truth;
-- treat any sim-based number as indicative only.
--
-- Schemas: priced_treatment -> base_hex_pricing; bought_treatment/slot/ehr_slot ->
-- base_hex_pc; art_claim -> the consolidated/ART schema. Confirm the materialized
-- DBs in your dbt target; all live in the same Snowflake account as ALE.

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
        BOOLOR_AGG(CONFIDENCE = 'UNABLE_TO_PRICE')    AS any_unpriced
    FROM ALE.ALE_DEV.AGENTIC_PRICER_RESULTS
    WHERE STATUS = 'COMPLETED'
    GROUP BY REQUEST_ID, HRT_ID
),

joined AS (
    SELECT
        s.REQUEST_ID,
        s.HRT_ID,
        s.stratum,
        s.sampling_reason,
        s.p,
        s.shadow_conf_rank,
        s.any_unpriced,
        s.shadow_price,
        pt.price                            AS air_price,                   -- AIR's prediction
        ac.total_adjudicated_responsibility AS actual_pr,                   -- ground truth
        ac.claim_id,
        ac.art_claim_status,
        (s.shadow_price - ac.total_adjudicated_responsibility) AS shadow_err, -- + over / - UNDERprice (costly)
        (pt.price        - ac.total_adjudicated_responsibility) AS air_err
    FROM shadow s
    JOIN base_hex_pricing.priced_treatment pt
      ON pt.request_id = s.REQUEST_ID
     AND pt.hrt_id     = s.HRT_ID
    JOIN base_hex_pc.bought_treatment bt ON bt.priced_treatment_id = pt.priced_treatment_id
    JOIN base_hex_pc.slot             sl ON sl.slot_id             = bt.slot_id
    JOIN base_hex_pc.ehr_slot         es ON es.ehr_slot_id         = sl.ehr_slot_id
    JOIN art_claim                    ac ON ac.visit_id::varchar   = es.ehr_visit_id::varchar
                                        AND ac.org_id::varchar     = es.org_id::varchar
    WHERE ac.total_adjudicated_responsibility IS NOT NULL          -- claim has returned/adjudicated
      AND s.shadow_price IS NOT NULL
      AND NOT s.any_unpriced                                        -- only treatments the agent actually priced
)

-- Population-level, inclusion-probability-weighted scorecard. Slice by confidence
-- and stratum to test "better than AIR on data-rich plans, worse on rare ones".
SELECT
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
GROUP BY shadow_conf_rank
ORDER BY shadow_conf_rank DESC;

-- ── Per-SRT / per-CPT variant (finer grain, for multi-treatment visits) ─────────
-- Replace the claim-level actual with ART's CPT-line responsibility and join on the
-- SRT's billing code instead of rolling up to HRT:
--   ... JOIN prod_core.base_hex_pricing.srt_to_billing_code sb ON sb.srt_id = r.SRT_ID
--       JOIN <art_claim_cpt_line> cl ON cl.claim_id = ac.claim_id AND cl.procedure_code = sb.billing_code
--   compare r.ESTIMATED_PATIENT_RESP (per SRT) against cl.adjudicated_patient_responsibility.
-- Use when one visit bundles several treatments and the claim total can't be split cleanly.
