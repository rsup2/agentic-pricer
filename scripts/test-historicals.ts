/**
 * Local test for the canonical (MedRite/cross-EHR) historicals rework.
 * Pulls a real org-24 (Experity/MedRite) member's identifiers in-process (never
 * printed), then exercises gatherPatientHistory (own) + gatherGroupIntelligence
 * (group) directly. Proves: (a) own-history returns Experity rows keyed by member
 * id, (b) no "Numeric value '<guid>' is not recognized" crash, (c) group intel.
 * Prints only de-identified samples (procedure/date/pnr/source), no member id/name.
 */
import { gatherPatientHistory, gatherGroupIntelligence } from '../src/pricing/gather.js';
import { executeQuery, drainPool } from '../src/tools/snowflake.js';

const ENTITY_ID = process.argv[2] ?? '9b0d7bac-8cc9-4896-828a-37e767bd1994';
const SERVICE_DATE = '2026-07-01T00:00:00Z';

function deid(rows: Record<string, unknown>[]) {
  return rows.slice(0, 5).map((r) => ({
    source_system: r.SOURCE_SYSTEM,
    procedure_code: r.PROCEDURE_CODE,
    modifier: r.MODIFIER,
    date_of_service: r.DATE_OF_SERVICE,
    pnr: r.PNR,
    payment: r.PAYMENT,
    plan: r.PAYER_PLAN_NAME,
  }));
}

async function main() {
  const [ent] = await executeQuery<{ MEMBER_ID: string; GROUP_NUMBER: string | null; ORG_ID: number }>(
    `SELECT requestinfo:primaryInsurance:memberId::string AS member_id,
            requestinfo:primaryInsurance:groupNumber::string AS group_number,
            requestinfo:orgId::int AS org_id
     FROM prod_raw.raw_air_mongo.pricing_entities WHERE id = ?`,
    [ENTITY_ID],
  );
  if (!ent) throw new Error(`no pricing entity ${ENTITY_ID}`);
  console.log(`entity ${ENTITY_ID}  org=${ent.ORG_ID}  memberId.len=${ent.MEMBER_ID?.length}  group=${ent.GROUP_NUMBER ? 'present' : 'none'}`);

  const dto: any = {
    orgId: ent.ORG_ID,
    serviceDate: SERVICE_DATE,
    primaryInsurance: { memberId: ent.MEMBER_ID, payer: 'x', groupNumber: ent.GROUP_NUMBER ?? undefined },
  };

  console.log('\n--- gatherPatientHistory (OWN, member-keyed canonical) ---');
  const own = await gatherPatientHistory(dto);
  console.log('note:', own.note, '| rows:', own.rows.length);
  console.log('sample:', JSON.stringify(deid(own.rows), null, 2));

  console.log('\n--- gatherGroupIntelligence (GROUP) ---');
  const grp = await gatherGroupIntelligence(dto, ent.GROUP_NUMBER ?? null);
  console.log('note:', grp.note, '| rows:', grp.rows.length);
  console.log('sample:', JSON.stringify(deid(grp.rows), null, 2));
}
main().catch((e) => { console.error('FAILED:', e); process.exitCode = 1; }).finally(() => void drainPool());
