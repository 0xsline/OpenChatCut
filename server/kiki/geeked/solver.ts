// GeeTest v4 solver — load captcha → generate `w` (signer) → verify → seccode + w.
// Port of GeekedTest geeked.py. /load+/verify hit gcaptcha4.geevisit.com (GeeTest infra,
// no Cloudflare → plain fetch works from Node/Electron, no curl_cffi needed).
// Proven working against KikiVoice (captcha_id 5046cffe...) on 2026-07-26.
import { randomUUID } from 'node:crypto';
import { generateW, type GeeTestData } from './signer.ts';

const GEE_BASE = 'https://gcaptcha4.geevisit.com';
const MAX_ROUNDS = 5;

export interface GeeTestSeccode {
  captcha_id?: string;
  lot_number: string;
  pass_token: string;
  gen_time: string;
  captcha_output?: string;
}

export interface SolveResult {
  seccode: GeeTestSeccode;
  /** The `w` param — used as captcha_output for the site's validation POST if seccode lacks it. */
  w: string;
}

function callback(): string {
  return `geetest_${Math.floor(Math.random() * 10000) + Date.now()}`;
}

function parseJsonp(text: string, cb: string): Record<string, unknown> {
  // GeeTest wraps responses as JSONP `cb({...});`. The previous split-based parse threw TypeError
  // if the response wasn't JSONP (error/rate-limit page → split[1] undefined) and broke if a
  // trailing `;` was present (slice(0,-1) only stripped one char). Regex + .data validation is robust.
  const match = new RegExp(`${cb}\\((.*)\\);?$`, 's').exec(text);
  if (!match) throw new Error(`GeeTest: non-JSONP response: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(match[1]) as { data?: Record<string, unknown> };
  if (!parsed.data) throw new Error(`GeeTest: response missing .data: ${text.slice(0, 120)}`);
  return parsed.data;
}

async function loadCaptcha(captchaId: string, riskType: string, cb: string): Promise<GeeTestData> {
  const url = `${GEE_BASE}/load?captcha_id=${captchaId}&challenge=${randomUUID()}&client_type=web&risk_type=${riskType}&lang=eng&callback=${cb}`;
  const data = parseJsonp(await (await fetch(url)).text(), cb);
  return {
    lot_number: String(data.lot_number),
    pow_detail: data.pow_detail as GeeTestData['pow_detail'],
    payload: String(data.payload),
    process_token: String(data.process_token),
    pt: String(data.pt),
  };
}

async function submitCaptcha(data: GeeTestData, captchaId: string, riskType: string, w: string, cb: string): Promise<GeeTestSeccode | null> {
  const params = new URLSearchParams({
    callback: cb, captcha_id: captchaId, client_type: 'web',
    lot_number: data.lot_number, risk_type: riskType, payload: data.payload,
    process_token: data.process_token, payload_protocol: '1', pt: String(data.pt ?? '1'), w,
  });
  const res = parseJsonp(await (await fetch(`${GEE_BASE}/verify?${params.toString()}`)).text(), cb);
  const seccode = (res as { seccode?: GeeTestSeccode }).seccode;
  return seccode ?? null;
}

/**
 * Solve a GeeTest v4 captcha (risk_type ai/invisible — no image challenge).
 * Returns { seccode, w } on success, null if no seccode after MAX_ROUNDS.
 * The caller POSTs the seccode to the site's validation endpoint (e.g. KikiVoice /jsapi/auth/geetest-validation).
 */
export async function solveGeetest(captchaId: string, riskType: string = 'ai'): Promise<SolveResult | null> {
  // One transient throw (network/parse) inside a round used to abort all remaining rounds — wrap
  // each round so a single flaky /load or /verify doesn't kill the whole solve.
  let lastError = '';
  for (let attempt = 1; attempt <= MAX_ROUNDS; attempt++) {
    try {
      const cb = callback();
      const data = await loadCaptcha(captchaId, riskType, cb);
      const w = generateW(data, captchaId);
      const seccode = await submitCaptcha(data, captchaId, riskType, w, callback());
      if (seccode) return { seccode, w };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (lastError) console.warn(`[geetest] solve failed after ${MAX_ROUNDS} rounds: ${lastError}`);
  return null;
}
