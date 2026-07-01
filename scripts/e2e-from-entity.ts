/**
 * End-to-end local test from a real AIR pricing entity.
 * Fetches pricing_entities.requestinfo, maps it to the shadow PricingRequestDto
 * (mirrors AIR's toShadowDto — defaults serviceDate to now when absent), and runs
 * the full runPricing (payer/STC + own+group canonical history + STEDI + synthesis).
 * Prints a DE-IDENTIFIED summary (no member id / names): org, payer, prices,
 * confidence, and the ownHistoricals/groupHistoricals source snippets so you can
 * SEE the new PNR-based history feeding the agent.
 *
 *   npx tsx --env-file=.env scripts/e2e-from-entity.ts <entityId> [<entityId> ...]
 */
import { runPricing } from '../src/pricing/run.js';
import { estimateCostUsd } from '../src/pricing/cost.js';
import { PricingRequestDtoSchema, type PricingRequestDto } from '../src/pricing/types.js';
import { executeQuery, drainPool } from '../src/tools/snowflake.js';

function mapToShadowDto(ri: any): PricingRequestDto {
  const ins = ri.primaryInsurance ?? {};
  const dto = {
    consumerId: ri.consumerId,
    firstName: ri.firstName,
    lastName: ri.lastName,
    dateOfBirth: ri.dateOfBirth,
    ehrPatientId: ri.ehrPatientId != null ? String(ri.ehrPatientId) : undefined,
    serviceDate: ri.serviceDate ? new Date(ri.serviceDate).toISOString() : new Date().toISOString(),
    primaryInsurance: {
      memberId: String(ins.memberId),
      payer: ins.payer,
      planName: ins.planName,
      state: ins.state,
      groupNumber: ins.groupNumber != null ? String(ins.groupNumber) : undefined,
      insuredFirstName: ins.insuredFirstName,
      insuredLastName: ins.insuredLastName,
    },
    npi: ri.npi != null ? String(ri.npi) : undefined,
    providerFirstName: ri.providerFirstName,
    providerLastName: ri.providerLastName,
    orgId: Number(ri.orgId),
    hrtToSrts: (ri.hrtToSrts ?? []).map((h: any) => ({
      hrtId: Number(h.hrtId),
      srtIds: (h.srtIds ?? []).map((n: any) => Number(n)),
    })),
    coverageSpend: ri.coverageSpendOverride ?? ri.coverageSpend,
  };
  return PricingRequestDtoSchema.parse(dto);
}

async function runOne(id: string) {
  const [row] = await executeQuery<{ REQUESTINFO: unknown }>(
    `SELECT requestinfo FROM prod_raw.raw_air_mongo.pricing_entities WHERE id = ?`, [id]);
  if (!row) { console.log(`\n### ${id}: no such entity`); return; }
  const ri = typeof row.REQUESTINFO === 'string' ? JSON.parse(row.REQUESTINFO) : row.REQUESTINFO;
  let dto: PricingRequestDto;
  try { dto = mapToShadowDto(ri); } catch (e) { console.log(`\n### ${id}: DTO map failed:`, (e as Error).message); return; }

  console.log(`\n############################################################`);
  console.log(`### ${id}  org=${dto.orgId}  payer=${dto.primaryInsurance.payer}  serviceDate=${dto.serviceDate.slice(0,10)}  hrts=${dto.hrtToSrts.length}`);
  const t = Date.now();
  const res = await runPricing(dto);
  const blocked = res.output.srtPrices.every((p) => p.confidence === 'UNABLE_TO_PRICE');
  console.log(`### verdict: ${blocked ? 'STEDI-BLOCKED / all UNABLE_TO_PRICE' : 'PRICED'}  (${Date.now()-t}ms, ${res.usage.inputTokens}in/${res.usage.outputTokens}out tok, $${estimateCostUsd(res.modelId, res.usage).toFixed(3)})`);
  for (const p of res.output.srtPrices) {
    console.log(`  srt ${p.srtId}: $${p.estimatedPatientResponsibility ?? 'null'} ${p.benefitType ?? ''} ${p.confidence}`);
  }
  const sb: any = res.output.srtPrices[0]?.sourceBreakdown;
  if (sb) {
    console.log(`  ownHistoricals : ${String(sb.ownHistoricals).slice(0, 200)}`);
    console.log(`  groupHistoricals: ${String(sb.groupHistoricals).slice(0, 160)}`);
    console.log(`  stedi          : ${String(sb.stedi).slice(0, 140)}`);
  }
}

async function main() {
  const ids = process.argv.slice(2);
  if (!ids.length) { console.error('usage: e2e-from-entity.ts <entityId> ...'); process.exit(1); }
  for (const id of ids) {
    try { await runOne(id); } catch (e) { console.log(`### ${id}: FAILED`, (e as Error).message?.slice(0, 300)); }
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => void drainPool());
