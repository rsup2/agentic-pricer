-- Shadow agentic-pricer results.
-- One row per (request_id x SRT). Run-level cost/latency columns are repeated
-- on each SRT row of the same run (so you can group by run_id to dedupe them).
--
-- request_id is the JOIN KEY: when the real claim adjudicates later, join your
-- engine's recorded requestId to this table to compare shadow-predicted vs actual,
-- plus see exactly what each shadow price cost in tokens/latency.

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

    CREATED_AT             TIMESTAMP_NTZ DEFAULT CURRENT_TIMESTAMP()
);

-- If the table already exists from before these columns were added, run:
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS SAMPLING_STRATUM STRING;
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS INCLUSION_PROBABILITY FLOAT;
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS SAMPLING_REASON STRING;
--   ALTER TABLE ALE.ALE_DEV.AGENTIC_PRICER_RESULTS ADD COLUMN IF NOT EXISTS AIR_REQUEST_TYPE STRING;
