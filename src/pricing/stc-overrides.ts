/**
 * Org-specific STC / benefit overrides, ported from the agentic-pricer skill
 * (sourced from AIR `pricing-manager.service.ts` as of June 2026).
 *
 * Applied AFTER the srt->STC DB lookup and BEFORE constructing STEDI calls.
 * Returns the effective {primary, secondaries} STC chain for a given
 * (org, payer, hrt, srt) context. When no override matches, the caller falls
 * back to the SRT's DB-default primary/secondary STCs.
 *
 * NOTE: this is intentionally a direct port of the documented rules. Some rules
 * are payer/hrt-name/srt-id conditional; the resolver below encodes the ones
 * that are unambiguous from the table and leaves a structured `notes` trail so
 * the synthesis agent can see which override (if any) fired.
 */

export type StcChain = { primary: string; secondaries: string[]; note?: string };

export type OverrideContext = {
  orgId: number;
  payer: string;
  hrtId: number;
  hrtName?: string;
  srtId: number;
};

const lc = (s?: string) => (s ?? '').toLowerCase();
const payerIs = (payer: string, ...needles: string[]) =>
  needles.some((n) => lc(payer).includes(n));

// OB ultrasound SRTs shared by orgs 9 & 10.
const OB_ULTRASOUND_SRTS = new Set([160, 465, 356, 276, 337, 353, 277]);
// org 10 OB HRTs / PCP HRTs.
const NEWLIFE_OB_HRTS = new Set([949, 950, 1007, 1008]);
const NEWLIFE_PCP_HRTS = new Set([1020, 1019, 939, 999]);
// org 27 / 39 Carefirst BCBS secondary-BY SRTs.
const CAREFIRST_BY_SRTS = new Set([131, 141, 142, 164, 2011, 2035]);
// pain/anesthesia SRTs (non-facility).
const PAIN_ANESTHESIA_SRTS = new Set([204, 407, 436]);

/**
 * Resolve the effective STC chain for an SRT given org/payer context.
 * `dbDefault` is the {primary, secondaries} from the SRT table lookup.
 */
export function resolveStcChain(ctx: OverrideContext, dbDefault: StcChain): StcChain {
  const { orgId, payer, hrtId, hrtName, srtId } = ctx;

  // Org 7 — Hudson Mind: always primary MH.
  if (orgId === 7) {
    return { primary: 'MH', secondaries: dbDefault.secondaries, note: 'org7 Hudson Mind: force MH primary' };
  }

  // Org 16 — Rappore.
  if (orgId === 16) {
    if (payerIs(payer, 'oxford')) {
      return { primary: '96', secondaries: ['98', 'A6', 'A4'], note: 'org16 Rappore Oxford' };
    }
    return {
      primary: 'A6',
      secondaries: ['MH', 'A4'],
      note: payerIs(payer, 'uhc', 'united') ? 'org16 Rappore UHC (ignore deductible on A6 tile)' : 'org16 Rappore default',
    };
  }

  // Org 10 — New Life.
  if (orgId === 10) {
    const isObHrt =
      NEWLIFE_OB_HRTS.has(hrtId) ||
      /obstetrics.*(follow up|new patient)/i.test(hrtName ?? '');
    if (isObHrt) {
      if (payerIs(payer, 'bcbs', 'blue cross')) return { primary: 'BU', secondaries: ['BV'], note: 'org10 OB BCBS' };
      if (payerIs(payer, 'aetna', 'ghi', 'hip')) return { primary: '69', secondaries: ['BV'], note: 'org10 OB Aetna/GHI/HIP' };
      if (payerIs(payer, 'cigna')) return { primary: '69', secondaries: dbDefault.secondaries, note: 'org10 OB Cigna' };
      return { primary: '69', secondaries: dbDefault.secondaries, note: 'org10 OB default' };
    }
    if (OB_ULTRASOUND_SRTS.has(srtId)) return { primary: '5', secondaries: ['62', 'BV'], note: 'org10 OB ultrasound' };
    if (NEWLIFE_PCP_HRTS.has(hrtId)) return { primary: '98', secondaries: ['96'], note: 'org10 PCP HRT' };
  }

  // Org 9 — QOgyn: OB ultrasound override only.
  if (orgId === 9 && OB_ULTRASOUND_SRTS.has(srtId)) {
    return { primary: '5', secondaries: ['62', 'BV'], note: 'org9 OB ultrasound' };
  }

  // Orgs 23, 31, 32, 33, 34 — chiro/PT/wellness.
  if ([23, 31, 32, 33, 34].includes(orgId)) {
    if (/weight management/i.test(hrtName ?? '')) return dbDefault;
    return { primary: '96', secondaries: ['98'], note: 'chiro/PT primary 96' };
  }

  // Orgs 24, 43, 29 — urgent care.
  if ([24, 43, 29].includes(orgId)) {
    // NJ Medicaid replacement plans flip to 98/UC — detected by payer name heuristic.
    if (payerIs(payer, 'medicaid') && payerIs(payer, 'nj', 'new jersey')) {
      return { primary: '98', secondaries: ['UC'], note: 'urgent care NJ Medicaid flip' };
    }
    return { primary: 'UC', secondaries: ['98'], note: 'urgent care primary UC' };
  }

  // Org 27 — MVS ophthalmology (vision); Carefirst BCBS secondary BY.
  if (orgId === 27) {
    if (payerIs(payer, 'carefirst') && CAREFIRST_BY_SRTS.has(srtId)) {
      return { primary: dbDefault.primary, secondaries: ['BY', ...dbDefault.secondaries], note: 'org27 Carefirst BY secondary' };
    }
    // primary 78 or 47 by payer for the configured vision SRT set is left to dbDefault
    // unless extended; flagged via note for the agent.
  }

  // Org 39 — BGE: Carefirst BCBS secondary BY.
  if (orgId === 39 && payerIs(payer, 'carefirst') && CAREFIRST_BY_SRTS.has(srtId)) {
    return { primary: dbDefault.primary, secondaries: ['BY', ...dbDefault.secondaries], note: 'org39 Carefirst BY secondary' };
  }

  // Orgs 11,12,13,14,18 (+6) — BVPA surgical/pain.
  if ([11, 12, 13, 14, 18].includes(orgId)) {
    if (PAIN_ANESTHESIA_SRTS.has(srtId)) {
      if (payerIs(payer, 'bcbs', 'blue cross')) return { primary: '7', secondaries: ['2', '98'], note: 'BVPA pain BCBS' };
      if (payerIs(payer, 'uhc', 'united')) return { primary: '7', secondaries: ['96', '98', '1'], note: 'BVPA pain UHC' };
      if (payerIs(payer, 'cigna')) return { primary: '30', secondaries: ['7', '98'], note: 'BVPA pain Cigna' };
      if (payerIs(payer, 'aetna')) return { primary: '98', secondaries: ['7', '2'], note: 'BVPA pain Aetna' };
      return { primary: '7', secondaries: ['2', '98'], note: 'BVPA pain default' };
    }
    // surgical / surgical-adjacent
    if (payerIs(payer, 'bcbs', 'blue cross')) return { primary: '2', secondaries: ['8', '1'], note: 'BVPA surgical BCBS' };
    if (payerIs(payer, 'cigna')) return { primary: '2', secondaries: ['30', '1'], note: 'BVPA surgical Cigna' };
    if (payerIs(payer, 'uhc', 'united')) return { primary: '2', secondaries: ['96', '8', '1'], note: 'BVPA surgical UHC' };
    if (payerIs(payer, 'aetna')) return { primary: '98', secondaries: ['7', '2'], note: 'BVPA surgical Aetna' };
    return { primary: '2', secondaries: ['1', '98'], note: 'BVPA surgical default' };
  }

  // Org 44 — well visits / PCP.
  if (orgId === 44) {
    return { primary: '98', secondaries: ['96'], note: 'org44 PCP well-visit' };
  }

  return dbDefault;
}
