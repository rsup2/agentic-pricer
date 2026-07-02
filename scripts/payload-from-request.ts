/**
 * Build a POST /price payload from a real AIR requestId (for a local Swagger / curl
 * test). Reads RAW_AIR_MONGO.REQUESTS (AIR's request store) and maps it to the
 * shadow PricingRequestDto — the same field mapping AIR's toShadowDto uses.
 *
 * The full payload (which contains PHI: member id, DOB, names) is written to STDOUT
 * ONLY; a de-identified summary goes to STDERR. So you can pipe the payload straight
 * to your clipboard without it landing in logs:
 *
 *   npx tsx --env-file=.env scripts/payload-from-request.ts <requestId>            # view
 *   npx tsx --env-file=.env scripts/payload-from-request.ts <requestId> 2>/dev/null | pbcopy   # copy
 *
 * Then paste into Swagger (http://localhost:3000/ui -> POST /price -> Execute).
 * NOTE: this payload has NO `eligibility` field, so AP runs its own STEDI (the
 * fallback path). To exercise the AIR-forwarded path, add an `eligibility` array.
 */
import { PricingRequestDtoSchema } from '../src/pricing/types.js';
import { executeQuery, drainPool } from '../src/tools/snowflake.js';
import { runPricing } from '../src/pricing/run.js';

const parseVariant = (v: unknown): any =>
  typeof v === 'string' ? JSON.parse(v) : v;

async function main() {
  const requestId = process.argv[2];
  if (!requestId) {
    console.error('usage: payload-from-request.ts <requestId>');
    process.exit(1);
  }

  const [row] = await executeQuery<Record<string, unknown>>(
    `SELECT REQUESTID, FIRSTNAME, LASTNAME, DATEOFBIRTH, CONSUMERID, ORGID, NPI,
            PROVIDERLASTNAME, EHRPATIENTID, SERVICEDATE, PRIMARYINSURANCE, HRTTOSRTS
     FROM prod_raw.raw_air_mongo.requests
     WHERE REQUESTID = ?
     ORDER BY DATE DESC
     LIMIT 1`,
    [requestId],
  );
  if (!row) {
    console.error(`no REQUESTS row for requestId ${requestId}`);
    process.exit(1);
  }

  const ins = parseVariant(row.PRIMARYINSURANCE) ?? {};
  const hrtToSrts = (parseVariant(row.HRTTOSRTS) ?? []).map((h: any) => ({
    hrtId: Number(h.hrtId),
    srtIds: (h.srtIds ?? []).map((n: any) => Number(n)),
  }));

  const dto = PricingRequestDtoSchema.parse({
    consumerId: row.CONSUMERID ?? undefined,
    firstName: row.FIRSTNAME ?? undefined,
    lastName: row.LASTNAME ?? undefined,
    dateOfBirth: String(row.DATEOFBIRTH),
    ehrPatientId: row.EHRPATIENTID != null ? String(row.EHRPATIENTID) : undefined,
    serviceDate: row.SERVICEDATE
      ? new Date(row.SERVICEDATE as string).toISOString()
      : new Date().toISOString(),
    primaryInsurance: {
      memberId: String(ins.memberId),
      payer: ins.payer,
      planName: ins.planName ?? undefined,
      state: ins.state ?? undefined,
      groupNumber: ins.groupNumber != null ? String(ins.groupNumber) : undefined,
      insuredFirstName: ins.insuredFirstName ?? undefined,
      insuredLastName: ins.insuredLastName ?? undefined,
    },
    npi: row.NPI != null ? String(row.NPI) : undefined,
    providerLastName: row.PROVIDERLASTNAME ?? undefined,
    orgId: Number(row.ORGID),
    hrtToSrts,
  });

  const priceRequest = { requestId: String(row.REQUESTID), dto };

  // De-identified summary -> stderr always.
  console.error(
    `# org=${dto.orgId} payer=${dto.primaryInsurance.payer} state=${dto.primaryInsurance.state ?? '?'} ` +
      `serviceDate=${dto.serviceDate.slice(0, 10)} ehr=${dto.ehrPatientId ? 'yes' : 'no'} ` +
      `hrts=${dto.hrtToSrts.length} srts=${dto.hrtToSrts.flatMap((h) => h.srtIds).length}`,
  );

  // --run: price it through AP inline and print a DE-IDENTIFIED result (no PHI).
  // Otherwise print the full payload (PHI) to stdout only, for a Swagger/curl test.
  if (process.argv.includes('--run')) {
    const res = await runPricing(dto);
    console.error(`# eligibilitySource=${res.eligibilitySource} latency=${res.totalLatencyMs}ms`);
    for (const p of res.output.srtPrices) {
      console.error(`  srt ${p.srtId}: $${p.estimatedPatientResponsibility ?? 'null'} ${p.benefitType ?? ''} ${p.confidence}`);
      console.error(`    reasoning: ${String(p.reasoning).slice(0, 400)}`);
      const sb: any = p.sourceBreakdown ?? {};
      console.error(`    stedi: ${String(sb.stedi).slice(0, 220)}`);
      console.error(`    own:   ${String(sb.ownHistoricals).slice(0, 140)}`);
      console.error(`    group: ${String(sb.groupHistoricals).slice(0, 140)}`);
    }
    if (res.output.warnings?.length) console.error(`  warnings: ${res.output.warnings.join(' | ').slice(0, 300)}`);
    return;
  }

  console.log(JSON.stringify(priceRequest, null, 2));
}

main()
  .catch((e) => {
    console.error(String(e).slice(0, 300));
    process.exitCode = 1;
  })
  .finally(() => void drainPool());
