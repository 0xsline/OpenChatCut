// Multi-key rotation for the Assets providers (transcription + stock). Each
// provider keeps a POOL of keys in one secret env var (a 1-line JSON array, e.g.
// ASSEMBLYAI_API_KEYS='["ak_1","ak_2"]'); the legacy single-key slot
// (ASSEMBLYAI_API_KEY) is still honored as a 1-element fallback so existing
// .env.local files keep working.
//
// Strategy = FAIL-OVER ON LIMIT: pickKey() returns the first non-cooled-down
// key starting from the last one used; when an upstream responds with a trigger
// status (429 / 402), markRateLimited() parks that key for `cooldownMs` and the
// NEXT call to pickKey() advances to a healthy key. Cooldown state lives only
// here in memory (lost on restart, which is fine — a fresh boot treats every
// key as healthy until proven otherwise).
//
// Security invariant (mirrors keystore): a key VALUE never leaves this module
// except as an outbound auth header. poolStatus() exposes only a masked suffix
// (last 4 chars) + a status word for the settings UI — safe to echo to the
// browser via the non-secret keyPools channel in keyStatus().
import { getKey } from './keystore.ts';

export interface RotatableProvider {
  /** 'ASSEMBLYAI' | 'PEXELS' | … — also the key into the runtime state Map. */
  readonly id: string;
  /** Secret env var holding the 1-line JSON key array. */
  readonly secretPool: string;
  /** Legacy single-key slot; used as a 1-element pool when secretPool is empty. */
  readonly legacySingle: string;
  /** How long a rate-limited key is parked before pickKey() will try it again. */
  readonly cooldownMs: number;
  /** Upstream HTTP statuses that trigger fail-over (rate-limit / quota). */
  readonly triggerStatus: readonly number[];
}

export const ROTATABLE: readonly RotatableProvider[] = [
  { id: 'ASSEMBLYAI', secretPool: 'ASSEMBLYAI_API_KEYS',  legacySingle: 'ASSEMBLYAI_API_KEY',    cooldownMs: 60_000, triggerStatus: [429, 402] },
  { id: 'PEXELS',     secretPool: 'PEXELS_API_KEYS',      legacySingle: 'PEXELS_API_KEY',        cooldownMs: 60_000, triggerStatus: [429, 402] },
  { id: 'PIXABAY',    secretPool: 'PIXABAY_API_KEYS',     legacySingle: 'PIXABAY_API_KEY',       cooldownMs: 60_000, triggerStatus: [429, 402] },
  { id: 'UNSPLASH',   secretPool: 'UNSPLASH_ACCESS_KEYS', legacySingle: 'UNSPLASH_ACCESS_KEY',   cooldownMs: 60_000, triggerStatus: [429, 402] },
  { id: 'FREESOUND',  secretPool: 'FREESOUND_API_KEYS',   legacySingle: 'FREESOUND_API_KEY',     cooldownMs: 60_000, triggerStatus: [429, 402] },
  { id: 'DVIDS',      secretPool: 'DVIDS_API_KEYS',       legacySingle: 'DVIDS_API_KEY',         cooldownMs: 60_000, triggerStatus: [429, 402] },
];

const BY_ID = new Map(ROTATABLE.map((p) => [p.id, p] as const));

/** Map a secret env-var NAME → provider, regardless of whether it's the pool or
 *  the legacy single slot. Used by setKeys to know which names are pool JSON. */
export function providerByEnvName(name: string): RotatableProvider | undefined {
  return ROTATABLE.find((p) => p.secretPool === name || p.legacySingle === name);
}
/** Is this env-var name a rotatable POOL (JSON array)? */
export function isPoolEnvName(name: string): boolean {
  return ROTATABLE.some((p) => p.secretPool === name);
}

interface ProviderState {
  /** Cooldown deadline (epoch ms) keyed by the key VALUE — so removing or
   *  reordering a key carries ITS OWN cooldown with it instead of shifting the
   *  deadline onto an unrelated slot (a positional array would mis-attribute a
   *  parked key's cooldown to its neighbor after a removal). */
  cooldownUntil: Map<string, number>;
  /** The key VALUE last handed out by pickKey() (survives pool reordering). */
  lastPickedKey: string | null;
}

const state = new Map<string, ProviderState>();

function providerOrThrow(id: string): RotatableProvider {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`unknown rotatable provider: ${id}`);
  return p;
}

/** Parse a pool env value into a clean key list: trim, drop empties, dedupe
 *  (preserving order). Returns [] on malformed JSON. NEVER throws. */
export function parsePoolValue(raw: string): string[] {
  if (!raw.trim()) return [];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const k = v.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** A pool edit from the settings UI, expressed as MUTATIONS against the currently
 *  stored pool. Secret values are never echoed to the browser, so the UI can only
 *  remove existing keys (by their original index) and append new ones — it cannot
 *  show or retype the stored values. The server reads its own stored secrets and
 *  applies the mutation. */
export interface PoolMutation {
  /** Indices (into the pool as last saved) to delete. */
  readonly rm: readonly number[];
  /** New keys to append. */
  readonly add: readonly string[];
}

/** Parse a staged pool value (`{rm,add}` JSON). Returns null if it isn't a valid
 *  mutation object. NEVER throws. */
export function parsePoolMutation(raw: string): PoolMutation | null {
  const trimmed = raw.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  let obj: unknown;
  try { obj = JSON.parse(trimmed); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as { rm?: unknown; add?: unknown };
  const rm = Array.isArray(o.rm)
    ? o.rm.filter((n): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0)
    : [];
  const add = Array.isArray(o.add)
    ? o.add.filter((s): s is string => typeof s === 'string')
    : [];
  return { rm, add };
}

/** Apply a mutation onto the currently STORED pool JSON (read server-side only)
 *  and return the canonical 1-line JSON to persist ('' when emptied). Dedupes
 *  preserving order. Nothing in the output is new information to the browser. */
export function applyPoolMutation(
  storedPoolJson: string, rm: readonly number[], add: readonly string[],
): string {
  const current = parsePoolValue(storedPoolJson);
  const removeSet = new Set(rm);
  const merged = current.filter((_, i) => !removeSet.has(i));
  for (const k of add) {
    const t = k.trim();
    if (t) merged.push(t);
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of merged) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out.length ? JSON.stringify(out) : '';
}

/** Current key list for a provider: the pool, or the legacy single as a
 *  1-element fallback. Empty array = unconfigured. */
export function getPool(id: string): string[] {
  const p = providerOrThrow(id);
  const pool = parsePoolValue(getKey(p.secretPool));
  if (pool.length) return pool;
  const legacy = getKey(p.legacySingle).trim();
  return legacy ? [legacy] : [];
}

/** Get-or-create the per-provider rotation state. Cooldowns are value-keyed, so
 *  no positional re-alignment is needed when the pool grows/shrinks/reorders — a
 *  removed key simply stops being looked up. */
function getState(id: string): ProviderState {
  providerOrThrow(id);
  let s = state.get(id);
  if (!s) {
    s = { cooldownUntil: new Map(), lastPickedKey: null };
    state.set(id, s);
  }
  return s;
}

export interface PickedKey {
  key: string;
  index: number;
}

/** Pick the next healthy key (fail-over: skip cooled-down ones). Returns null
 *  only when the pool is empty. Updates lastPickedKey to the chosen key. */
export function pickKey(id: string): PickedKey | null {
  const pool = getPool(id);  // getPool validates the provider id
  if (!pool.length) return null;
  const st = getState(id);
  const now = Date.now();
  const cool = (k: string): boolean => (st.cooldownUntil.get(k) ?? 0) > now;
  // Start from where we last picked (by value, so reordering doesn't reset it).
  const startIdx = st.lastPickedKey ? Math.max(0, pool.indexOf(st.lastPickedKey)) : 0;
  for (let off = 0; off < pool.length; off++) {
    const i = (startIdx + off) % pool.length;
    if (!cool(pool[i])) {
      st.lastPickedKey = pool[i];
      return { key: pool[i], index: i };
    }
  }
  // Every key is cooling down — fail OPEN (still hand out a key rather than
  // hard-failing the request) by picking the one whose cooldown ends soonest,
  // so the next healthy slot is reused first.
  let soonest = 0;
  for (let i = 1; i < pool.length; i++) {
    if ((st.cooldownUntil.get(pool[i]) ?? Infinity) < (st.cooldownUntil.get(pool[soonest]) ?? Infinity)) soonest = i;
  }
  st.lastPickedKey = pool[soonest];
  return { key: pool[soonest], index: soonest };
}

/** The key pickKey() would hand out next, WITHOUT advancing lastPicked or
 *  mutating rotation state. Use this for read-only getters (e.g. the stock
 *  plugin's "is this platform configured?" check) so mere inspection doesn't
 *  rotate the active key. Returns '' when the pool is empty. */
export function peekActiveKey(id: string): string {
  const pool = getPool(id);
  if (!pool.length) return '';
  const st = getState(id);  // get-or-create only; does NOT advance lastPickedKey
  const now = Date.now();
  const startIdx = st.lastPickedKey ? Math.max(0, pool.indexOf(st.lastPickedKey)) : 0;
  for (let off = 0; off < pool.length; off++) {
    const i = (startIdx + off) % pool.length;
    if ((st.cooldownUntil.get(pool[i]) ?? 0) <= now) return pool[i];
  }
  return pool[startIdx];  // every key cooling — return the last-picked slot
}

/** Park a key for cooldownMs after an upstream rate-limit / quota response. */
export function markRateLimited(id: string, index: number): void {
  const p = providerOrThrow(id);
  const pool = getPool(id);
  if (index < 0 || index >= pool.length) return;
  const st = getState(id);
  st.cooldownUntil.set(pool[index], Date.now() + p.cooldownMs);
  // Advance lastPickedKey off the just-parked key so the next pickKey() prefers another.
  if (pool.length > 1) st.lastPickedKey = pool[(index + 1) % pool.length];
}

/** Park the key whose VALUE matches — for consumers that hold the picked value
 *  (via a getter) but not its index, e.g. the stock plugin's pure searchStockMedia
 *  which receives keys through its `options` rather than calling pickKey() itself.
 *  No-op if the value isn't in the current pool (so test fixtures with literal
 *  keys are unaffected). */
export function markRateLimitedByValue(id: string, keyValue: string): void {
  const p = providerOrThrow(id);
  const pool = getPool(id);
  if (!pool.includes(keyValue)) return;  // literal test keys aren't in the pool
  const st = getState(id);
  st.cooldownUntil.set(keyValue, Date.now() + p.cooldownMs);
  if (pool.length > 1) st.lastPickedKey = pool[(pool.indexOf(keyValue) + 1) % pool.length];
}

/** Does this upstream HTTP status mean "switch keys"? */
export function shouldFailover(id: string, httpStatus: number): boolean {
  const p = providerOrThrow(id);
  return p.triggerStatus.includes(httpStatus);
}

export type KeyHealth = 'active' | 'cooldown' | 'exhausted';

export interface KeySlotStatus {
  /** Masked suffix, e.g. "…3a9f" (or "…" for very short keys). Never the value. */
  readonly suffix: string;
  /** 'active' = eligible to be picked; 'cooldown' = parked after a limit; 'exhausted' = no healthy key exists right now (only set on the picked slot when ALL are cooling). */
  readonly status: KeyHealth;
  /** Seconds of cooldown remaining (0 when healthy). */
  readonly cooldownSeconds: number;
}

export interface PoolStatus {
  readonly id: string;
  readonly count: number;
  /** Index pickKey() will hand out next, or -1 if pool empty. */
  readonly activeIndex: number;
  readonly keys: readonly KeySlotStatus[];
}

function maskSuffix(key: string): string {
  return key.length <= 4 ? '…' : `…${key.slice(-4)}`;
}

/** Browser-safe status for one provider (suffix + status only — no values). */
export function poolStatus(id: string): PoolStatus {
  const pool = getPool(id);  // validates the provider id
  const st = getState(id);
  const now = Date.now();
  const anyHealthy = pool.some((k) => (st.cooldownUntil.get(k) ?? 0) <= now);
  const activeIndex = pool.length
    ? Math.max(0, st.lastPickedKey ? pool.indexOf(st.lastPickedKey) : 0)
    : -1;
  const keys: KeySlotStatus[] = pool.map((key) => {
    const deadline = st.cooldownUntil.get(key) ?? 0;
    const cooling = deadline > now;
    const remaining = cooling ? Math.ceil((deadline - now) / 1000) : 0;
    const status: KeyHealth = !cooling ? 'active' : anyHealthy ? 'cooldown' : 'exhausted';
    return { suffix: maskSuffix(key), status, cooldownSeconds: remaining };
  });
  return { id, count: pool.length, activeIndex, keys };
}

/** All provider statuses, for the keyPools channel of keyStatus(). */
export function allPoolStatuses(): Record<string, PoolStatus> {
  const out: Record<string, PoolStatus> = {};
  for (const p of ROTATABLE) out[p.id] = poolStatus(p.id);
  return out;
}

/** Test seam: clear all runtime cooldown state. Not part of the app flow. */
export function __resetRotationState(): void {
  state.clear();
}
