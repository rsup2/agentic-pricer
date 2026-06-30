-- Shadow agentic-pricer results.
-- One row per (request_id x SRT). Run-level cost/latency columns are repeated
-- on each SRT row of the same run (so you can group by run_id to dedupe them).
--
-- request_id is the JOIN KEY: when the real claim adjudicates later, join your
-- engine's recorded requestId to this table to compare shadow-predicted vs actual,
-- plus see exactly what each shadow price cost in tokens/latency.
--
-- ⚠️ LIVE LOCATION = PLAYGROUND.MISC.AGENTIC_PRICER_RESULTS (the deployed table; the
--    service's RESULTS_* env points here). env.ts DEFAULTS to ALE.ALE_DEV — if you
--    rely on defaults instead of the deployed .env you'll write to the wrong table.
--
-- ⚠️⚠️ DEPLOY ORDER: the live table does NOT yet have the four SAMPLING_* columns.
--    Run the ALTERs below on PLAYGROUND.MISC *before* deploying the writer change,
--    or every INSERT will fail with "invalid identifier SAMPLING_STRATUM".

CREATE TABLE IF NOT EXISTS PLAYGROUND.MISC.AGENTIC_PRICER_RESULTS (
    REQUEST_ID              STRING        NOT NULL,   -- join key to claims later
    RUN_ID                  STRING,                   -- mastra workflow run id
    HRT_ID                  NUMBER,
    SRT_ID                  NUMBER,

    -- pricing output (per SRT) --
    ESTIMATED_PATIENT_RESP  NUMBER(12,2),             -- null when UNABLE_TO_PRICE
    BENEFIT_TYPE            STRING,                    -- COPAY / COINSURANCE / DEDUCTIBLE / ...
    CONFIDENCE             STRING        NOT NULL,   -- HIGH / MEDIUM / LOW / UNABLE_TO_PRICE (NOT NULL in live table)
    REASONING              STRING,
    SOURCE_BREAKDOWN       VARIANT,                   -- {stedi, ownHistoricals, groupHistoricals, webSearch, allowableSource}

    -- run-level diagnostics (repeated per SRT row) --
    WARNINGS               VARIANT,
    TOTAL_LATENCY_MS       NUMBER,
    STEP_LATENCY_MS        VARIANT,                   -- {payerStc, history, stedi, group, web, synthesis}
    INPUT_TOKENS           NUMBER,
    OUTPUT_TOKENS          NUMBER,
    CACHE_READ_TOKENS      NUMBER,
    ESTIMATED_COST_USD     NUMBER(12,6),
    MODEL_ID               STRING,

    -- provenance --
    PRICING_DATE           DATE,                      -- dto.serviceDate (date the price is "as of")
    DTO_DIGEST             STRING,                    -- short hash of the request DTO for traceability
    STATUS                 STRING,                    -- COMPLETED / ERROR
    ERROR_MESSAGE          STRING,                    -- populated when STATUS = ERROR

    -- sampling provenance (set by AIR's shadow sampler; null on manual/direct calls) --
    SAMPLING_STRATUM       STRING,                    -- e.g. "org:12|payer:aetna"
    INCLUSION_PROBABILITY  FLOAT,                     -- sampling rate that admitted this request; weight rows by 1/this
    SAMPLING_REASON        STRING,                    -- floor / tail
    AIR_REQUEST_TYPE       STRING,                    -- PriceTreatmentsDto.requestType on the AIR side

    CREATED_AT             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- ⚠️ RUN THIS ON THE LIVE TABLE BEFORE DEPLOYING THE WRITER CHANGE (verified
-- 2026-06-30 that PLAYGROUND.MISC does NOT yet have these columns):
--   ALTER TABLE PLAYGROUND.MISC.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS SAMPLING_STRATUM STRING;
--   ALTER TABLE PLAYGROUND.MISC.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS INCLUSION_PROBABILITY FLOAT;
--   ALTER TABLE PLAYGROUND.MISC.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS SAMPLING_REASON STRING;
--   ALTER TABLE PLAYGROUND.MISC.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS AIR_REQUEST_TYPE STRING;
