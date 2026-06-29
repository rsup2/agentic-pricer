/**
 * Throwaway probe: run the real payer lookup + STC-30 eligibility for one member
 * and dump where any "group"-looking field appears in the STEDI 271 response.
 * Run: npm run probe:group   (uses --env-file=.env)
 */
import { gatherPayerAndStc } from '../src/pricing/gather.js';
import { checkEligibility } from '../src/tools/stedi.js';
import { toYmd } from '../src/pricing/gather.js';

const dto = {
  firstName: 'CLAUDETTE',
  lastName: 'PACE',
  dateOfBirth: '1967-08-14',
  ehrPatientId: '352584',
  serviceDate: '2026-06-15T18:30:00.000Z',
  primaryInsurance: {
    memberId: '804049283',
    payer: 'United Healthcare',
    state: 'NY',
    insuredFirstName: 'CLAUDETTE',
    insuredLastName: 'PACE',
  },
  orgId: 6,
  hrtToSrts: [{ hrtId: 429, srtIds: [141] }],
} as never;

/** Walk an object and collect every path whose key contains "group" (case-insensitive). */
function findGroupPaths(obj: unknown, path = '$'): Array<[string, unknown]> {
  const hits: Array<[string, unknown]> = [];
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const p = Array.isArray(obj) ? `${path}[${k}]` : `${path}.${k}`;
      if (k.toLowerCase().includes('group')) hits.push([p, v]);
      hits.push(...findGroupPaths(v, p));
    }
  }
  return hits;
}

async function main() {
  const payer = await gatherPayerAndStc(dto);
  console.log('payerCandidates:', payer.payerCandidates);
  console.log('chosen payerStediId:', payer.payerStediId);
  if (!payer.payerStediId) {
    console.log('No working payer id — cannot probe STC 30.');
    return;
  }

  console.log('resolved provider:', { npi: payer.providerNpi, lastName: payer.providerLastName });
  const r = await checkEligibility({
    tradingPartnerServiceId: payer.payerStediId,
    npi: payer.providerNpi ?? undefined,
    providerLastName: payer.providerLastName ?? undefined,
    memberId: dto.primaryInsurance.memberId,
    subscriberFirstName: dto.primaryInsurance.insuredFirstName,
    subscriberLastName: dto.primaryInsurance.insuredLastName,
    dateOfBirth: dto.dateOfBirth,
    dateOfService: toYmd(dto.serviceDate),
    serviceTypeCodes: ['30'],
  });

  if (!r.ok) {
    console.log('STC-30 probe failed:', r.error);
    return;
  }

  console.log('\n=== top-level keys ===');
  console.log(Object.keys(r.response));
  console.log('\n=== subscriber block ===');
  console.log(JSON.stringify(r.response.subscriber ?? null, null, 2));
  console.log('\n=== every key containing "group" ===');
  for (const [p, v] of findGroupPaths(r.response)) {
    console.log(p, '=', JSON.stringify(v));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
