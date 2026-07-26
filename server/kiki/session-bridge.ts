// KikiVoice session bridge — module-level registrar (mirrors the keystore `store` pattern).
// The Electron main process (desktop/embedded-server) calls setKikiSessionBridge() at boot with a
// persist:partition session getter; server plugins read it lazily at request time.
// In pure-Vite browser-dev nothing registers → KikiVoice reports "requires desktop" (no session).
// Avoids threading a param through serverPlugins() (which both vite.config and embedded-server call).

import type { Session } from 'electron';

export const KIKI_DEFAULT_BASE_URL = 'https://kikivoice.ai';
export const KIKI_DEFAULT_MODEL = 'kiki_core';
export const KIKI_DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';
/** Bundled Indonesian clone ref (copied from OpenCut-AI f5-tts voices). Relative to cwd. */
export const KIKI_DEFAULT_REF_AUDIO = 'public/voices/joni.wav';

export interface KikiSessionBridge {
  /** persist:partition session carrying uuid+cf_clearance+fpestid. null until Electron logs in. */
  getSession: () => Session | null;
  refAudioPath?: string;
  baseUrl?: string;
  model?: string;
  userAgent?: string;
  /** Clears a GeeTest 777 (per-IP re-check) during synth by crypto-solving GeeTest (GeekedTest)
   *  and POSTing the seccode to KikiVoice's validation endpoint via Electron net. Resolves true
   *  if the session is still authed afterwards. Electron-only. */
  revalidate?: () => Promise<boolean>;
  /** Inject a Netscape cookie file's rows into the persist:kiki session (manual-upload fallback —
   *  OpenCut-AI's proven path when auto GeeTest-solve can't acquire the cookie). Returns count set. */
  setCookiesFromNetscape?: (text: string) => Promise<number>;
}

let bridge: KikiSessionBridge | null = null;

export function setKikiSessionBridge(next: KikiSessionBridge): void {
  bridge = next;
  (globalThis as Record<string, unknown>).__kikiVoiceBridge = true;
}

export function clearKikiSessionBridge(): void {
  bridge = null;
  // Reset the availability flag too — otherwise keystore.computeCaps.voice stays true after the
  // bridge is gone (false-positive capability) and the agent would route to a dead transport.
  delete (globalThis as Record<string, unknown>).__kikiVoiceBridge;
}

export function getKikiBridge(): KikiSessionBridge | null {
  return bridge;
}

// ── Quota cache (passive capture from create-task responses) ─────────────────
import type { KikiQuotaSnapshot } from './types.ts';

let quotaCache: KikiQuotaSnapshot | null = null;

export function setKikiQuota(q: KikiQuotaSnapshot): void { quotaCache = q; }
export function getKikiQuota(): KikiQuotaSnapshot | null { return quotaCache; }
