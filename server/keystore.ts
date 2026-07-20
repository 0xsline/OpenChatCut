// Server-side in-memory API-key store backing the settings UI. Seeded from .env.local
// at Vite startup, live-updated by POST /api/keys, and persisted back to .env.local so
// runtime edits survive a restart. SECRET key VALUES (any name NOT in NON_SECRET_NAMES)
// live ONLY here (server-side) and in .env.local (gitignored) — they NEVER appear in
// any response; the browser sees booleans only (keyStatus / caps). Model ids and vendor
// routing are configuration, not credentials: the explicit NON_SECRET_NAMES whitelist
// lets keyStatus() echo their raw values (keyStatus().models) so the settings UI can
// show and edit them.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AI_SDK_BASE_URL_FORMAT, resolveLlmBaseUrl } from './llm-config.ts';
import {
  LLM_PROVIDER_PRESETS,
  llmProviderConfigNames,
  normalizeLlmProvider,
} from '../shared/llm-providers.ts';

const ENV_PATH = resolve(process.cwd(), '.env.local');

// Whitelist of settable env vars — mirrors what vite.config.ts reads. POST /api/keys
// rejects anything outside this set so the endpoint can never write arbitrary env.
export const KEY_NAMES = [
  'LLM_API_KEY', 'LLM_BASE_URL', 'LLM_BASE_URL_FORMAT',
  'LLM_ANTHROPIC_API_KEY', 'LLM_ANTHROPIC_BASE_URL', 'LLM_ANTHROPIC_MODEL',
  'LLM_OPENAI_API_KEY', 'LLM_OPENAI_BASE_URL', 'LLM_OPENAI_MODEL', 'LLM_OPENAI_API_MODE',
  'LLM_GEMINI_API_KEY', 'LLM_GEMINI_BASE_URL', 'LLM_GEMINI_MODEL',
  'LLM_KIMI_API_KEY', 'LLM_KIMI_BASE_URL', 'LLM_KIMI_MODEL',
  'LLM_QWEN_API_KEY', 'LLM_QWEN_BASE_URL', 'LLM_QWEN_MODEL',
  'LLM_GLM_API_KEY', 'LLM_GLM_BASE_URL', 'LLM_GLM_MODEL',
  'LLM_DEEPSEEK_API_KEY', 'LLM_DEEPSEEK_BASE_URL', 'LLM_DEEPSEEK_MODEL',
  'LLM_MINIMAX_API_KEY', 'LLM_MINIMAX_BASE_URL', 'LLM_MINIMAX_MODEL',
  'LLM_MISTRAL_API_KEY', 'LLM_MISTRAL_BASE_URL', 'LLM_MISTRAL_MODEL',
  'IMAGE_API_KEY', 'OPENAI_API_KEY', 'IMAGE_BASE_URL',
  'GEMINI_API_KEY', 'GEMINI_BASE_URL',
  'ELEVENLABS_API_KEY', 'ELEVENLABS_BASE_URL',
  'DOUBAO_TTS_APP_ID', 'DOUBAO_TTS_ACCESS_KEY', 'DOUBAO_TTS_BASE_URL',
  'SEEDANCE_API_KEY', 'SEEDANCE_BASE_URL', 'KLING_API_KEY', 'KLING_BASE_URL',
  'MUREKA_API_KEY', 'MUREKA_BASE_URL',
  'MINIMAX_API_KEY', 'MINIMAX_BASE_URL',
  'PEXELS_API_KEY', 'PIXABAY_API_KEY', 'UNSPLASH_ACCESS_KEY', 'FREESOUND_API_KEY',
  'ASSEMBLYAI_API_KEY',
  'E2B_API_KEY', 'E2B_TEMPLATE',
  'FIRECRAWL_API_KEY',
  'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_ENABLED', 'R2_PRESIGN',
  'MEDIA_DIR',
  // ── model ids (non-secret config; raw values echoed via keyStatus().models) ──
  'LLM_PROVIDER', 'LLM_MODEL',
  'GEMINI_IMAGE_MODEL', 'MINIMAX_IMAGE_MODEL',
  'ELEVENLABS_TTS_MODEL', 'DOUBAO_TTS_RESOURCE_ID', 'MINIMAX_TTS_MODEL',
  'ELEVENLABS_SOUND_MODEL',
  'SEEDANCE_VIDEO_MODEL', 'KLING_VIDEO_MODEL', 'MINIMAX_VIDEO_MODEL',
  'MUREKA_MUSIC_MODEL', 'MINIMAX_MUSIC_MODEL',
  // ── vendor routing (non-secret config) ──
  'PREFERRED_IMAGE_VENDOR', 'PREFERRED_VOICE_VENDOR',
  'PREFERRED_VIDEO_VENDOR', 'PREFERRED_MUSIC_VENDOR',
] as const;
export type KeyName = (typeof KEY_NAMES)[number];
const SETTABLE = new Set<string>(KEY_NAMES);

// Names whose VALUES may be sent to the browser (model ids / vendor routing — config,
// not credentials). Deliberately a separate explicit list rather than derived from
// KEY_NAMES: adding a key to the whitelist must never accidentally make it non-secret.
export const NON_SECRET_NAMES: ReadonlySet<string> = new Set([
  'LLM_PROVIDER', 'LLM_MODEL', 'LLM_OPENAI_API_MODE',
  'GEMINI_IMAGE_MODEL', 'ELEVENLABS_TTS_MODEL', 'ELEVENLABS_SOUND_MODEL',
  'DOUBAO_TTS_RESOURCE_ID', 'SEEDANCE_VIDEO_MODEL', 'KLING_VIDEO_MODEL', 'MUREKA_MUSIC_MODEL',
  'MINIMAX_TTS_MODEL', 'MINIMAX_VIDEO_MODEL', 'MINIMAX_MUSIC_MODEL', 'MINIMAX_IMAGE_MODEL',
  'PREFERRED_IMAGE_VENDOR', 'PREFERRED_VOICE_VENDOR', 'PREFERRED_VIDEO_VENDOR', 'PREFERRED_MUSIC_VENDOR',
  'R2_ENABLED', // 云同步开关('' 缺省=启用,'0'=停用)——配置不是凭据
  'R2_PRESIGN', // 浏览器预签名直传('' 缺省=启用,'0'=仅服务端写穿)
  'MEDIA_DIR',  // 素材保存目录(本机路径,''=默认 public/media/uploads)——配置不是凭据
  ...LLM_PROVIDER_PRESETS.flatMap((preset) => {
    const names = llmProviderConfigNames(preset.id);
    return [names.baseUrl, names.model];
  }),
]);

const store = new Map<string, string>();  // current value per key (seed + runtime overrides)
const envSeeded = new Set<string>();       // which keys came from .env.local / process.env at startup

/** Seed the store from Vite's loaded env (+ process.env fallback). Call once at startup. */
export function seedKeystore(env: Record<string, string>): void {
  for (const name of KEY_NAMES) {
    const v = (env[name] ?? process.env[name] ?? '').trim();
    if (v) { store.set(name, v); envSeeded.add(name); }
  }
  // One-time in-memory compatibility migration. Old installs had a single LLM
  // tuple; attach it to the provider that was active when those values were saved.
  const legacyProvider = normalizeLlmProvider(store.get('LLM_PROVIDER'));
  const names = llmProviderConfigNames(legacyProvider);
  const migrate = (target: string, value: string): void => {
    if (!store.has(target) && value) {
      store.set(target, value);
      envSeeded.add(target);
    }
  };
  migrate(names.apiKey, store.get('LLM_API_KEY') ?? '');
  migrate(
    names.baseUrl,
    store.has('LLM_BASE_URL')
      ? resolveLlmBaseUrl(legacyProvider, store.get('LLM_BASE_URL'), store.get('LLM_BASE_URL_FORMAT'))
      : '',
  );
  migrate(names.model, store.get('LLM_MODEL') ?? '');
}

/** Live value for a key (runtime override wins over the .env.local seed). '' if unset. */
export function getKey(name: KeyName): string {
  return store.get(name) ?? '';
}

// Capability booleans derived from current key presence — SAME logic as the vite.config
// `define` snapshot, but computed live so the agent perceives runtime key changes.
export interface Caps {
  image: boolean; voice: boolean; video: boolean; music: boolean; sound: boolean;
  stock: boolean; transcription: boolean; sandbox: boolean; web: boolean; storage: boolean;
}
export function computeCaps(): Caps {
  const has = (n: KeyName): boolean => getKey(n).length > 0;
  return {
    image: has('IMAGE_API_KEY') || has('OPENAI_API_KEY') || has('GEMINI_API_KEY') || has('MINIMAX_API_KEY'),
    voice: (has('DOUBAO_TTS_APP_ID') && has('DOUBAO_TTS_ACCESS_KEY')) || has('ELEVENLABS_API_KEY') || has('MINIMAX_API_KEY'),
    video: has('SEEDANCE_API_KEY') || has('KLING_API_KEY') || has('MINIMAX_API_KEY'),
    music: has('MUREKA_API_KEY') || has('MINIMAX_API_KEY'),
    sound: has('ELEVENLABS_API_KEY'),
    stock: has('PEXELS_API_KEY') || has('PIXABAY_API_KEY') || has('UNSPLASH_ACCESS_KEY')
      || has('FREESOUND_API_KEY') || has('FIRECRAWL_API_KEY'),
    transcription: has('ASSEMBLYAI_API_KEY'),
    sandbox: has('E2B_API_KEY'),
    web: has('FIRECRAWL_API_KEY'),
    storage: has('R2_ACCOUNT_ID') && has('R2_ACCESS_KEY_ID') && has('R2_SECRET_ACCESS_KEY') && has('R2_BUCKET')
      && getKey('R2_ENABLED') !== '0',
  };
}

export interface KeyState { configured: boolean; source: 'env' | 'runtime' | 'none'; }
export interface KeyStatus { keys: Record<string, KeyState>; caps: Caps; models: Record<string, string>; }

/** Browser-facing status. SECURITY INVARIANT: a SECRET key's value (any name not in
 * NON_SECRET_NAMES) NEVER appears in this (or any) response — secrets surface as
 * booleans + source only. Non-secret model/routing values are echoed raw in `models`
 * ('' when unset); the `keys` boolean map still covers every whitelisted name. */
export function keyStatus(): KeyStatus {
  const keys: Record<string, KeyState> = {};
  const models: Record<string, string> = {};
  for (const name of KEY_NAMES) {
    const set = getKey(name).length > 0;
    keys[name] = { configured: set, source: set ? (envSeeded.has(name) ? 'env' : 'runtime') : 'none' };
    if (NON_SECRET_NAMES.has(name)) models[name] = getKey(name);
  }
  return { keys, caps: computeCaps(), models };
}

/** Apply key edits from the settings UI: validate, update memory, persist to .env.local.
 * Empty value clears a key. Values containing newlines are rejected. Unknown names ignored. */
export async function setKeys(patch: Record<string, unknown>): Promise<void> {
  let clean = new Map<string, string>();
  for (const [name, raw] of Object.entries(patch)) {
    if (!SETTABLE.has(name)) continue;  // whitelist
    const v = String(raw ?? '');
    if (/[\r\n]/.test(v)) throw new Error(`invalid value for ${name}: no newlines allowed`);
    const t = v.trim();
    if (t.includes('"') && t.includes("'")) throw new Error(`invalid value for ${name}: cannot contain both quote types`);
    clean.set(name, t);
  }
  if (clean.size === 0) return;
  if (clean.has('LLM_BASE_URL') && !clean.has('LLM_BASE_URL_FORMAT')) {
    clean.set('LLM_BASE_URL_FORMAT', clean.get('LLM_BASE_URL') ? AI_SDK_BASE_URL_FORMAT : '');
  }
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

/** One .env line. dotenv treats an unquoted `#` as an inline comment and strips a fully
 * quote-wrapped value's quotes on read — so values containing `#` or fully wrapped in
 * quotes must be re-quoted (with whichever quote char the value doesn't contain; both at
 * once is rejected in setKeys) or they'd silently degrade across a dev-server restart. */
function envLine(name: string, v: string): string {
  const needsQuote = v.includes('#')
    || (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))));
  if (!needsQuote) return `${name}=${v}`;
  const q = v.includes('"') ? "'" : '"';
  return `${name}=${q}${v}${q}`;
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
      if (v) out.push(envLine(m[1], v));  // empty → drop the line (cleared)
    } else {
      out.push(line);
    }
  }
  for (const [name, v] of patch) {
    if (!seen.has(name) && v) out.push(envLine(name, v));
  }
  return out.join('\n') + '\n';
}
