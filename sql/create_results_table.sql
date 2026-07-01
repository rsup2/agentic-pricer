-- Shadow agentic-pricer results.
-- One row per (request_id x SRT). Run-level cost/latency columns are repeated
-- on each SRT row of the same run (so you can group by run_id to dedupe them).
--
-- request_id is the JOIN KEY: when the real claim adjudicates later, join your
-- engine's recorded requestId to this table to compare shadow-predicted vs actual,
-- plus see exactly what each shadow price cost in tokens/latency.
--
-- LIVE LOCATION = ALE.ALE_DEV.AGENTIC_PRICER_RESULTS (matches env.ts defaults).
-- Verified 2026-06-30: the table exists with the full schema below, including the
-- four SAMPLING_* columns, so the writer change needs no migration. (Confirm the
-- Aptible RESULTS_* config points here; the repo's local .env may still say
-- PLAYGROUND.MISC, which only affects local runs.)

CREATE TABLE IF NOT EXISTS ALE.ALE_DEV.AGENTIC_PRICER_RESULTS (
    REQUEST_ID              STRING        NOT NULL,   -- join key to claims later
    RUN_ID                  STRING,                   -- mastra workflow run id
    HRT_ID                  NUMBER,
    SRT_ID                  NUMBER,

    -- pricing output (per SRT) --
    ESTIMATED_PATIENT_RESP  NUMBER(12,2),             -- null when UNABLE_TO_PRICE
    BENEFIT_TYPE            STRING,                    -- COPAY / COINSURANCE / DEDUCTIBLE / ...
    CONFIDENCE             STRING,                    -- HIGH / MEDIUM / LOW / UNABLE_TO_PRICE
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

    -- code-version provenance (which build produced this price) --
    PRICER_VERSION         STRING,                    -- short git SHA (APTIBLE_GIT_COMMIT_SHA), 'dev' locally
    PRICER_LABEL           STRING,                    -- human-readable build name (e.g. 'pnr-historicals')
    PRICER_COMMIT_URL      STRING,                    -- GitHub commit link (APTIBLE_GIT_COMMIT_URL); PR is one click away

    CREATED_AT             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- If you stand up the table in another environment (e.g. ALE.ALE_PROD) that predates
-- these columns, backfill them before the writer runs there:
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS SAMPLING_STRATUM STRING;
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS INCLUSION_PROBABILITY FLOAT;
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS SAMPLING_REASON STRING;
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS AIR_REQUEST_TYPE STRING;

-- Version provenance columns — run these to add them to the existing ALE_DEV table:
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS PRICER_VERSION STRING;
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS PRICER_LABEL STRING;
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS PRICER_COMMIT_URL STRING;
