// Server-side in-memory API-key store backing the settings UI. Seeded from .env.local
// at Vite startup, live-updated by POST /api/keys, and persisted back to .env.local so
// runtime edits survive a restart. Key VALUES live ONLY here (server-side) and in
// .env.local (gitignored) — the browser only ever receives booleans (keyStatus / caps).
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ENV_PATH = resolve(process.cwd(), '.env.local');

// Whitelist of settable env vars — mirrors what vite.config.ts reads. POST /api/keys
// rejects anything outside this set so the endpoint can never write arbitrary env.
export const KEY_NAMES = [
  'LLM_API_KEY', 'LLM_BASE_URL',
  'IMAGE_API_KEY', 'OPENAI_API_KEY', 'IMAGE_BASE_URL',
  'GEMINI_API_KEY', 'GEMINI_BASE_URL',
  'ELEVENLABS_API_KEY', 'ELEVENLABS_BASE_URL',
  'DOUBAO_TTS_APP_ID', 'DOUBAO_TTS_ACCESS_KEY', 'DOUBAO_TTS_BASE_URL',
  'SEEDANCE_API_KEY', 'SEEDANCE_BASE_URL', 'KLING_API_KEY', 'KLING_BASE_URL',
  'MUREKA_API_KEY', 'MUREKA_BASE_URL',
  'PEXELS_API_KEY', 'PIXABAY_API_KEY',
  'ASSEMBLYAI_API_KEY',
  'E2B_API_KEY', 'E2B_TEMPLATE',
  'FIRECRAWL_API_KEY',
] as const;
export type KeyName = (typeof KEY_NAMES)[number];
const SETTABLE = new Set<string>(KEY_NAMES);

const store = new Map<string, string>();  // current value per key (seed + runtime overrides)
const envSeeded = new Set<string>();       // which keys came from .env.local / process.env at startup

/** Seed the store from Vite's loaded env (+ process.env fallback). Call once at startup. */
export function seedKeystore(env: Record<string, string>): void {
  for (const name of KEY_NAMES) {
    const v = (env[name] ?? process.env[name] ?? '').trim();
    if (v) { store.set(name, v); envSeeded.add(name); }
  }
}

/** Live value for a key (runtime override wins over the .env.local seed). '' if unset. */
export function getKey(name: KeyName): string {
  return store.get(name) ?? '';
}

// Capability booleans derived from current key presence — SAME logic as the vite.config
// `define` snapshot, but computed live so the agent perceives runtime key changes.
export interface Caps {
  image: boolean; voice: boolean; video: boolean; music: boolean; sound: boolean;
  stock: boolean; transcription: boolean; sandbox: boolean; web: boolean;
}
export function computeCaps(): Caps {
  const has = (n: KeyName): boolean => getKey(n).length > 0;
  return {
    image: has('IMAGE_API_KEY') || has('OPENAI_API_KEY') || has('GEMINI_API_KEY'),
    voice: (has('DOUBAO_TTS_APP_ID') && has('DOUBAO_TTS_ACCESS_KEY')) || has('ELEVENLABS_API_KEY'),
    video: has('SEEDANCE_API_KEY') || has('KLING_API_KEY'),
    music: has('MUREKA_API_KEY'),
    sound: has('ELEVENLABS_API_KEY'),
    stock: has('PEXELS_API_KEY') || has('PIXABAY_API_KEY'),
    transcription: has('ASSEMBLYAI_API_KEY'),
    sandbox: has('E2B_API_KEY'),
    web: has('FIRECRAWL_API_KEY'),
  };
}

export interface KeyState { configured: boolean; source: 'env' | 'runtime' | 'none'; }
export interface KeyStatus { keys: Record<string, KeyState>; caps: Caps; }

/** Browser-facing status — BOOLEANS + source only, NEVER any key value. */
export function keyStatus(): KeyStatus {
  const keys: Record<string, KeyState> = {};
  for (const name of KEY_NAMES) {
    const set = getKey(name).length > 0;
    keys[name] = { configured: set, source: set ? (envSeeded.has(name) ? 'env' : 'runtime') : 'none' };
  }
  return { keys, caps: computeCaps() };
}

/** Apply key edits from the settings UI: validate, update memory, persist to .env.local.
 * Empty value clears a key. Values containing newlines are rejected. Unknown names ignored. */
export async function setKeys(patch: Record<string, unknown>): Promise<void> {
  const clean = new Map<string, string>();
  for (const [name, raw] of Object.entries(patch)) {
    if (!SETTABLE.has(name)) continue;  // whitelist
    const v = String(raw ?? '');
    if (/[\r\n]/.test(v)) throw new Error(`invalid value for ${name}: no newlines allowed`);
    clean.set(name, v.trim());
  }
  if (clean.size === 0) return;
  for (const [name, v] of clean) {
    if (v) { store.set(name, v); envSeeded.delete(name); }  // now a runtime value
    else store.delete(name);
  }
  const existing = await readFile(ENV_PATH, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  await writeFile(ENV_PATH, mergeEnvText(existing, clean), 'utf8');
}

/** Merge `patch` into a .env file's text: update lines whose key matches, drop lines whose
 * new value is empty (cleared), append genuinely-new keys, and preserve every other line
 * (comments, blanks, unrelated vars). Pure — the IO in setKeys wraps this. */
export function mergeEnvText(existing: string, patch: Map<string, string>): string {
  const lines = existing.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();  // drop split's trailing '' from final newline
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m && patch.has(m[1])) {
      seen.add(m[1]);
      const v = patch.get(m[1])!;
      if (v) out.push(`${m[1]}=${v}`);  // empty → drop the line (cleared)
    } else {
      out.push(line);
    }
  }
  for (const [name, v] of patch) {
    if (!seen.has(name) && v) out.push(`${name}=${v}`);
  }
  return out.join('\n') + '\n';
}
