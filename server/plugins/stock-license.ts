// License gate for archival/geopolitical stock footage — STRICT PD / CC-BY only.
// Ported from OpenCut-AI services/license_gate.py. Required for monetization:
// only public-domain / CC-BY / CC0 footage is allowed. Copyrighted footage
// (state media, wire services) is blocked here before it reaches the timeline.
// DVIDS contractor "special works" (Reuters/AP/Getty clips on a US-gov platform)
// are blocked separately. Two-layer fail-closed:
//   1. reject TOXIC licenses (ShareAlike / NonCommercial / NoDerivs / GFDL)
//   2. accept ONLY safe licenses (PD / PD-USGov / CC0 / CC-BY)
// Anything failing both is rejected.

// Licenses that carry reuse restrictions we cannot satisfy for monetization.
// ShareAlike (CC-BY-SA), NonCommercial, NoDerivs, GFDL are all blockers.
const LICENSE_TOXIC =
  /(\bby-sa\b|\bby-nc\b|\bby-nd\b|\bsa\b|\bnc\b|\bnd\b|share\s*alike|non[- ]*commercial|no\s*deriv|\bgfdl\b)/i;

// Licenses that are monetization-safe. Matched against the full license string.
const LICENSE_SAFE =
  /(public\s*domain|\bcc0\b|\bpd\b|\bpd-?usgov\b|cc[- ]?by\b|attribution|copyright[- ]?free|u\.?s\.?\s*govern|works\s+of\s+the\s+federal)/i;

// Source attribution blocklist — state media + wire services are NOT PD even when
// hosted on a PD-leaning platform (a Reuters clip on Wikimedia Commons, a CCTV
// handout). Bare 'rt' matches without a suffix — that token is always Russia
// Today as an on-screen credit.
const SOURCE_BLOCKED =
  /(\bcnn\b|reuters|bbc|fox\s*news|c-?span|nato|\boryx\b|tasnim|fars\s*news|press\s*tv|irna|russia\s*today|\brt\b|\brt\.com|sputnik|ria\s*novosti|tass|\bcgtn\b|\bcctv\b|xinhua|global\s*times|people.?s?\s*daily|kcna|\bsana\b|al-mayadeen|telesur|associated\s*press|\bafp\b|getty|storyful|al\s*jazeera|bloomberg|bellingcat|\bdw\b|deutsche\s*welle|france\s*24|\bnhk\b|al\s*arabiya|sky\s*news\s*arabia)/i;

// DVIDS contractor "special works" — Reuters/AP/Getty clips masquerading on a
// US-gov platform. Block before treating the item as PD-USGov.
const DVIDS_CONTRACTOR =
  /(special\s*works|courtesy\s*of|reuters|associated\s*press|\bafp\b|getty|storyful|contractor)/i;

export type StockLicenseTag = 'PD' | 'PD-USGov' | 'CC0' | 'CC-BY';

export interface StockLicenseDecision {
  /** Refined safe-license tag, or null when the item is not monetization-safe. */
  tag: StockLicenseTag | null;
  /** True only when an explicit safe license matched (not just a provider default). */
  verified: boolean;
}

/** State media / wire service in an attribution field → not PD. */
export function isBlockedAttribution(attribution: string | undefined): boolean {
  return !!attribution && SOURCE_BLOCKED.test(attribution);
}

/** DVIDS contractor credit (Reuters/AP/Getty masquerading on a gov platform). */
export function isDvidsContractor(credit: string | undefined): boolean {
  return !!credit && DVIDS_CONTRACTOR.test(credit);
}

function refineTag(text: string): StockLicenseTag {
  const low = text.toLowerCase();
  if (/cc0|cc-0/.test(low)) return 'CC0';
  if (/usgov|u\.?s\.?\s*govern|federal/.test(low)) return 'PD-USGov';
  if (/cc[- ]?by\b/.test(low) && !/\bsa\b/.test(low)) return 'CC-BY';
  return 'PD';
}

/** Classify an explicit license string (+ attribution) for monetization safety.
 *  Returns {tag, verified:true} only when an explicit safe license matches and
 *  the attribution isn't a blocked source. Fail-closed (tag=null) otherwise. */
export function classifyStockLicense(
  licenseText: string | undefined,
  attribution: string | undefined,
): StockLicenseDecision {
  if (isBlockedAttribution(attribution)) return { tag: null, verified: false };
  const text = (licenseText ?? '').trim();
  if (!text) return { tag: null, verified: false };
  if (LICENSE_TOXIC.test(text)) return { tag: null, verified: false };
  if (LICENSE_SAFE.test(text)) return { tag: refineTag(text), verified: true };
  return { tag: null, verified: false }; // explicit but unrecognized → fail-closed
}

/** Wikimedia extmetadata fields are {value, source} objects whose value often
 *  carries HTML. Flatten to plain text. Accepts a raw string, a {value} object,
 *  or null. */
export function stripHtml(value: unknown): string {
  if (value == null) return '';
  const raw = typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null && 'value' in value
      ? String((value as { value?: unknown }).value ?? '')
      : String(value);
  return raw.replace(/<[^>]*>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// exposed for regression tests
export const STOCK_LICENSE_PATTERNS = { LICENSE_TOXIC, LICENSE_SAFE, SOURCE_BLOCKED, DVIDS_CONTRACTOR };
