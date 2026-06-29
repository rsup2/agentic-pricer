import { env } from '../env.js';

/**
 * Direct Stedi real-time eligibility (270/271) client — NOT the MCP.
 * Verified contract (June 2026):
 *   POST https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3
 *   Authorization: <bare api key>   (no "Bearer"/"Key" prefix)
 *
 * Benefit tile codes in response.benefitsInformation[]:
 *   A = Co-Insurance (benefitPercent), B = Co-Payment (benefitAmount),
 *   C = Deductible (benefitAmount), G = Out-of-Pocket. Amounts/percents are STRINGS.
 */
const STEDI_ELIGIBILITY_URL =
  'https://healthcare.us.stedi.com/2024-04-01/change/medicalnetwork/eligibility/v3';

export type StediEligibilityInput = {
  tradingPartnerServiceId: string; // payer id; preserve leading zeros
  npi?: string;
  providerOrganizationName?: string;
  providerFirstName?: string;
  providerLastName?: string;
  memberId: string;
  subscriberFirstName?: string;
  subscriberLastName?: string;
  dateOfBirth: string; // accepts YYYY-MM-DD or CCYYMMDD; normalized here
  serviceTypeCodes: string[];
  dateOfService: string; // accepts YYYY-MM-DD or CCYYMMDD; normalized here
};

/** Strip separators -> CCYYMMDD (Stedi's required date format). */
function toCcyymmdd(d: string): string {
  return d.replace(/-/g, '').slice(0, 8);
}

/** A single eligibility check for one STC set. Never throws — returns a tagged result. */
export async function checkEligibility(
  input: StediEligibilityInput,
): Promise<
  | { ok: true; stc: string; response: Record<string, unknown> }
  | { ok: false; stc: string; error: string }
> {
  const stc = input.serviceTypeCodes.join(',');
  const body: Record<string, unknown> = {
    tradingPartnerServiceId: input.tradingPartnerServiceId,
    provider: {
      npi: input.npi,
      ...(input.providerOrganizationName
        ? { organizationName: input.providerOrganizationName }
        : {}),
      // For an NPI-1 (individual) provider, payers reject a person loop that has
      // a last name but no first name with AAA-44 "Invalid/Missing Provider Name".
      // Always send firstName when we have it. (organizationName is for NPI-2 orgs.)
      ...(input.providerFirstName ? { firstName: input.providerFirstName } : {}),
      ...(input.providerLastName ? { lastName: input.providerLastName } : {}),
    },
    subscriber: {
      memberId: input.memberId,
      ...(input.subscriberFirstName ? { firstName: input.subscriberFirstName } : {}),
      ...(input.subscriberLastName ? { lastName: input.subscriberLastName } : {}),
      dateOfBirth: toCcyymmdd(input.dateOfBirth),
    },
    encounter: {
      serviceTypeCodes: input.serviceTypeCodes,
      dateOfService: toCcyymmdd(input.dateOfService),
    },
  };

  try {
    const res = await fetch(STEDI_ELIGIBILITY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: env.STEDI_API_KEY,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      return { ok: false, stc, error: `HTTP ${res.status}: ${JSON.stringify(json).slice(0, 500)}` };
    }
    // Top-level AAA-style rejections surface in errors[].
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      return { ok: false, stc, error: `AAA: ${JSON.stringify(json.errors).slice(0, 500)}` };
    }
    return { ok: true, stc, response: json };
  } catch (e) {
    return { ok: false, stc, error: (e as Error).message };
  }
}

/** Run many STC checks in parallel (one call per unique STC + STC 30). */
export async function checkEligibilityForStcs(
  base: Omit<StediEligibilityInput, 'serviceTypeCodes'>,
  stcs: string[],
): Promise<Awaited<ReturnType<typeof checkEligibility>>[]> {
  const unique = Array.from(new Set([...stcs, '30'])); // always include plan-level STC 30
  return Promise.all(
    unique.map((stc) => checkEligibility({ ...base, serviceTypeCodes: [stc] })),
  );
}
