# agentic-pricer-shadow

A [Mastra](https://mastra.ai) app that runs Superscript's **agentic pricer** against live
pricing traffic, **in parallel** to (and independent of) the main pricing engine. It is a
production port of the `/agentic-pricer` Claude Code skill.

The endpoint is **fire-and-forget**: it accepts a pricing request, returns `202` immediately,
prices in the background, and persists the result to Snowflake keyed by the incoming
`requestId` — so when the real claim adjudicates later you can line the shadow estimate up
against the actual patient responsibility. Each run records **per-step latency and per-price
token cost**.

```
main pricing service ──fire-and-forget──▶ POST /price ──202──▶ background run
                                                                 │
   parallel: payer/STC + patient history                         ▼
   then STEDI eligibility (needs payer id)              synthesis agent (Opus 4.8)
   then group/plan intelligence (needs group #)                   │
   then synthesis (+ web search)                                  ▼
                                                  Snowflake: ALE.ALE_DEV.AGENTIC_PRICER_RESULTS
                                                  (keyed by requestId, with latency + token cost)
```

## How it maps to the skill

| Skill stage | Here |
|---|---|
| Step 1a/1b payer + STC lookup | `src/tools/queries.ts` + `src/pricing/gather.ts` |
| Org STC overrides | `src/pricing/stc-overrides.ts` |
| Step 1c patient history (date-gated) | `gatherPatientHistory` |
| Step 2 STEDI eligibility | `src/tools/stedi.ts` (direct REST, not MCP) |
| Step 3 group/plan intelligence (date-gated) | `gatherGroupIntelligence` |
| Step 4 web search | inside the synthesis agent |
| Step 5 synthesis + confidence caps | `src/pricing/synthesis-agent.ts` |

The **NO-FOREKNOWLEDGE** guards (`claimservicedate < serviceDate` and
`transactioncreateddatetime < serviceDate`, strict `<`) are baked into the SQL in
`src/tools/queries.ts` and must not be relaxed. The synthesis agent has no DB access — it only
reasons over the already-date-gated data handed to it, so contamination is structurally removed.

## Endpoints

### `POST /price`
```json
{
  "requestId": "your-unique-id",     // JOIN KEY to claims later
  "dto": { /* the full pricing request DTO — see src/pricing/types.ts */ }
}
```
Returns `202 { requestId, status: "accepted", queueDepth }`. The DTO is the same shape the live
engine receives (`consumerId`, `primaryInsurance`, `serviceDate`, `orgId`, `hrtToSrts`, …).
Optionally include `coverageSpend` (the accumulator at request time) for best accuracy.

### `GET /healthcheck`
`{ status: "ok", queueDepth }` — used by Aptible's health probe.

## Local development

```bash
cp .env.example .env        # fill in ANTHROPIC_API_KEY, STEDI_API_KEY, SNOWFLAKE_*
npm install

# one-shot smoke test (no server, no Snowflake write):
#   put a DTO in scripts/sample-dto.json, then:
npm run smoke
#   or replay a real pricing entity:
npx tsx scripts/smoke.ts --entity <pricingEntityId>

# run the server locally:
npm run build && npm start          # listens on PORT (default 3000)
# then:
curl -XPOST localhost:3000/price -H 'content-type: application/json' \
  -d '{"requestId":"test-1","dto": { ... }}'
```

## Create the results table (one time)

```bash
# run sql/create_results_table.sql against Snowflake (any client / the Snowflake MCP):
#   ALE.ALE_DEV.AGENTIC_PRICER_RESULTS
```
Join later:
```sql
SELECT r.request_id, r.srt_id, r.estimated_patient_resp, r.confidence,
       r.total_latency_ms, r.estimated_cost_usd
FROM ALE.ALE_DEV.AGENTIC_PRICER_RESULTS r
WHERE r.request_id = '<the id your engine recorded>';
```

## Deploy to Aptible

This repo deploys via Aptible's **git push** build (Aptible builds the `Dockerfile`).

```bash
# 1. create the app (once)
aptible apps:create agentic-pricer-shadow

# 2. set secrets (NEVER commit these) — these crash the app at boot if missing
aptible config:set --app agentic-pricer-shadow \
  ANTHROPIC_API_KEY=... \
  STEDI_API_KEY=... \
  SNOWFLAKE_ACCOUNT=... SNOWFLAKE_USER=... SNOWFLAKE_PASSWORD=... \
  SNOWFLAKE_WAREHOUSE=COMPUTE_WH SNOWFLAKE_ROLE=ACCOUNTADMIN \
  MAX_CONCURRENT_RUNS=8 SYNTHESIS_MODEL=anthropic/claude-opus-4-8

# 3. add the aptible git remote and push (deploy)
git remote add aptible <git remote from `aptible apps`>
git push aptible main

# 4. expose the endpoint (HTTPS endpoint on the app's web service)
aptible endpoints:https:create --app agentic-pricer-shadow web

# 5. scale (horizontal replicas add headroom; the real ceiling is Anthropic/
#    Snowflake/STEDI rate limits, not container CPU — this workload is I/O-bound)
aptible apps:scale web --container-count 2 --container-size 1024 --app agentic-pricer-shadow
```

The container listens on `PORT` (Aptible injects this; defaults to 3000). `SIGTERM` triggers a
graceful flush of buffered results so a deploy doesn't drop in-flight prices.

## Scaling & concurrency

- `MAX_CONCURRENT_RUNS` caps in-flight runs per container; spikes queue (a backlog is fine for
  fire-and-forget). Raise it for more throughput per container.
- Add Aptible replicas for more headroom. But the global ceiling is your **Anthropic /
  Snowflake / STEDI** rate limits — replicas don't raise those.
- Results are micro-batched (`RESULTS_FLUSH_INTERVAL_MS` / `RESULTS_FLUSH_MAX_ROWS`) to avoid a
  Snowflake session per price.

## Cost tracking

Each persisted row carries `input_tokens`, `output_tokens`, `cache_read_tokens`,
`estimated_cost_usd` (computed in `src/pricing/cost.ts` from the model's per-MTok rates), and
`step_latency_ms`/`total_latency_ms`. Swap `SYNTHESIS_MODEL` to A/B cost vs accuracy across the
same live traffic — `model_id` is recorded per row.

## Security note

Do **not** commit `.env`. The Snowflake password and STEDI token are Aptible config secrets.
The repo's `.gitignore` excludes `.env`.
