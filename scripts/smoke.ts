/**
 * Smoke test: run ONE pricing request end-to-end WITHOUT the HTTP server or
 * Snowflake write, printing the result + latency + token cost.
 *
 * Usage:
 *   1. Put a real DTO in scripts/sample-dto.json (shape = PricingRequestDto), OR
 *      pass --entity <pricingEntityId> to fetch requestinfo from Snowflake first.
 *   2. npm run smoke
 *
 * Requires a populated .env (ANTHROPIC_API_KEY, STEDI_API_KEY, SNOWFLAKE_*).
 */
import { readFileSync } from 'node:fs';
import { runPricing } from '../src/pricing/run.js';
import { estimateCostUsd } from '../src/pricing/cost.js';
import { PricingRequestDtoSchema } from '../src/pricing/types.js';
import { executeQuery } from '../src/tools/snowflake.js';
import { drainPool } from '../src/tools/snowflake.js';

async function loadDto() {
  const entityIdx = process.argv.indexOf('--entity');
  if (entityIdx !== -1) {
    const id = process.argv[entityIdx + 1];
    const rows = await executeQuery<{ REQUESTINFO: unknown }>(
      `SELECT requestinfo FROM prod_raw.raw_air_mongo.pricing_entities WHERE id = ?`,
      [id],
    );
    if (!rows.length) throw new Error(`no pricing entity ${id}`);
    const ri = rows[0].REQUESTINFO;
    return PricingRequestDtoSchema.parse(typeof ri === 'string' ? JSON.parse(ri) : ri);
  }
  const raw = readFileSync(new URL('./sample-dto.json', import.meta.url), 'utf8');
  return PricingRequestDtoSchema.parse(JSON.parse(raw));
}

async function main() {
  const dto = await loadDto();
  console.log(`Pricing org=${dto.orgId} payer=${dto.primaryInsurance.payer} serviceDate=${dto.serviceDate}`);
  const t = Date.now();
  const result = await runPricing(dto);
  console.log(`\n=== RESULT (${Date.now() - t}ms wall) ===`);
  console.log(JSON.stringify(result.output, null, 2));
  console.log('\n=== DIAGNOSTICS ===');
  console.log('step latency (ms):', result.stepLatencyMs);
  console.log('total latency (ms):', result.totalLatencyMs);
  console.log('tokens:', result.usage);
  console.log('estimated cost USD:', estimateCostUsd(result.modelId, result.usage));
  console.log('model:', result.modelId);
  await drainPool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
