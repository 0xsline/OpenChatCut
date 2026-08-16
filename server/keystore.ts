// Server-side in-memory API-key store backing the settings UI. Seeded at Vite
// startup, live-updated by POST /api/keys, and persisted to the active runtime
// profile's private settings file. Secret values never appear in responses; the
// browser sees booleans only (keyStatus / caps). Model ids and vendor
// routing are configuration, not credentials: the explicit NON_SECRET_NAMES whitelist
// lets keyStatus() echo their raw values (keyStatus().models) so the settings UI can
// show and edit them.
import { readFile } from "node:fs/promises";
import { atomicWriteFile } from "./plugins/project-store-durable.ts";
import { AI_SDK_BASE_URL_FORMAT, resolveLlmBaseUrl } from "./llm-config.ts";
import { decodePersistedEnvValue, mergeEnvText } from "./env-text.ts";
export { mergeEnvText } from "./env-text.ts";
import { isIsolatedDevProfile, runtimeProfile } from "./runtime-profile.ts";
import {
  LLM_PROVIDER_PRESETS,
  llmProviderConfigNames,
  normalizeLlmProvider,
} from "../shared/llm-providers.ts";
import {
  MODEL_CAPABILITY_OVERRIDES_KEY,
  parseModelCapabilityOverrides,
  serializeModelCapabilityOverrides,
  type ModelCapabilityOverride,
} from "../shared/model-capabilities.ts";

const ACTIVE_PROFILE = runtimeProfile();
const ENV_PATH = ACTIVE_PROFILE.keystorePath;

// Whitelist of settable env vars — mirrors what vite.config.ts reads. POST /api/keys
// rejects anything outside this set so the endpoint can never write arbitrary env.
export const KEY_NAMES = [
  "AGENT_IMPORT_ROOTS",
  "PROXY_URL",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_BASE_URL_FORMAT",
  "LLM_ANTHROPIC_API_KEY",
  "LLM_ANTHROPIC_BASE_URL",
  "LLM_ANTHROPIC_MODEL",
  "LLM_OPENAI_API_KEY",
  "LLM_OPENAI_BASE_URL",
  "LLM_OPENAI_MODEL",
  "LLM_OPENAI_API_MODE",
  "LLM_GEMINI_API_KEY",
  "LLM_GEMINI_BASE_URL",
  "LLM_GEMINI_MODEL",
  "LLM_KIMI_API_KEY",
  "LLM_KIMI_BASE_URL",
  "LLM_KIMI_MODEL",
  "LLM_QWEN_API_KEY",
  "LLM_QWEN_BASE_URL",
  "LLM_QWEN_MODEL",
  "LLM_GLM_API_KEY",
  "LLM_GLM_BASE_URL",
  "LLM_GLM_MODEL",
  "LLM_DEEPSEEK_API_KEY",
  "LLM_DEEPSEEK_BASE_URL",
  "LLM_DEEPSEEK_MODEL",
  "LLM_STEPFUN_API_KEY",
  "LLM_STEPFUN_BASE_URL",
  "LLM_STEPFUN_MODEL",
  "LLM_BYTEPLUS_API_KEY",
  "LLM_BYTEPLUS_BASE_URL",
  "LLM_BYTEPLUS_MODEL",
  "LLM_MINIMAX_API_KEY",
  "LLM_MINIMAX_BASE_URL",
  "LLM_MINIMAX_MODEL",
  "LLM_XIAOMI_API_KEY",
  "LLM_XIAOMI_BASE_URL",
  "LLM_XIAOMI_MODEL",
  "LLM_MISTRAL_API_KEY",
  "LLM_MISTRAL_BASE_URL",
  "LLM_MISTRAL_MODEL",
  "LLM_OPENROUTER_API_KEY",
  "LLM_OPENROUTER_BASE_URL",
  "LLM_OPENROUTER_MODEL",
  "LLM_OLLAMA_API_KEY",
  "LLM_OLLAMA_BASE_URL",
  "LLM_OLLAMA_MODEL",
  "LLM_LMSTUDIO_API_KEY",
  "LLM_LMSTUDIO_BASE_URL",
  "LLM_LMSTUDIO_MODEL",
  "IMAGE_API_KEY",
  "OPENAI_API_KEY",
  "IMAGE_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "WAVESPEED_API_KEY",
  "WAVESPEED_BASE_URL",
  "BYTEPLUS_API_KEY",
  "BYTEPLUS_BASE_URL",
  "ELEVENLABS_API_KEY",
  "ELEVENLABS_BASE_URL",
  "DEEPGRAM_API_KEY",
  "GROQ_API_KEY",
  "GROQ_BASE_URL",
  "CARTESIA_API_KEY",
  "DOUBAO_TTS_APP_ID",
  "DOUBAO_TTS_ACCESS_KEY",
  "DOUBAO_TTS_BASE_URL",
  "INWORLD_TTS_API_KEY",
  "INWORLD_TTS_BASE_URL",
  "FISHAUDIO_TTS_API_KEY",
  "FISHAUDIO_TTS_BASE_URL",
  "SPEECHIFY_TTS_API_KEY",
  "SPEECHIFY_TTS_BASE_URL",
  "SEEDANCE_API_KEY",
  "SEEDANCE_BASE_URL",
  "KLING_API_KEY",
  "KLING_BASE_URL",
  "MUREKA_API_KEY",
  "MUREKA_BASE_URL",
  "MINIMAX_API_KEY",
  "MINIMAX_BASE_URL",
  "PEXELS_API_KEY",
  "PIXABAY_API_KEY",
  "UNSPLASH_ACCESS_KEY",
  "FREESOUND_API_KEY",
  "ASSEMBLYAI_API_KEY",
  "E2B_API_KEY",
  "E2B_TEMPLATE",
  "FIRECRAWL_API_KEY",
  "RESOURCE_PREVIEW_TOKEN",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_ENABLED",
  "R2_PRESIGN",
  "MEDIA_DIR",
  // ── model ids (non-secret config; raw values echoed via keyStatus().models) ──
  "LLM_PROVIDER",
  "LLM_MODEL",
  "CODEX_MODEL",
  "CODEX_REASONING_EFFORT",
  MODEL_CAPABILITY_OVERRIDES_KEY,
  "GEMINI_IMAGE_MODEL",
  "MINIMAX_IMAGE_MODEL",
  "WAVESPEED_IMAGE_MODEL",
  "BYTEPLUS_IMAGE_MODEL",
  "BYTEPLUS_VIDEO_MODEL",
  "ELEVENLABS_TTS_MODEL",
  "OPENAI_TTS_MODEL",
  "GEMINI_TTS_MODEL",
  "MISTRAL_TTS_MODEL",
  "CARTESIA_TTS_MODEL",
  "OPENAI_TRANSCRIPTION_MODEL",
  "MISTRAL_TRANSCRIPTION_MODEL",
  "DEEPGRAM_TRANSCRIPTION_MODEL",
  "GROQ_TRANSCRIPTION_MODEL",
  "ELEVENLABS_TRANSCRIPTION_MODEL",
  "CARTESIA_TRANSCRIPTION_MODEL",
  "DOUBAO_TTS_RESOURCE_ID",
  "INWORLD_TTS_MODEL",
  "FISHAUDIO_TTS_MODEL",
  "SPEECHIFY_TTS_MODEL",
  "MINIMAX_TTS_MODEL",
  "ELEVENLABS_SOUND_MODEL",
  "SEEDANCE_VIDEO_MODEL",
  "KLING_VIDEO_MODEL",
  "MINIMAX_VIDEO_MODEL",
  "MUREKA_MUSIC_MODEL",
  "MINIMAX_MUSIC_MODEL",
  // ── vendor routing (non-secret config) ──
  "PREFERRED_IMAGE_VENDOR",
  "PREFERRED_VOICE_VENDOR",
  "PREFERRED_VIDEO_VENDOR",
  "PREFERRED_MUSIC_VENDOR",
  "PREFERRED_TRANSCRIPTION_PROVIDER",
  "LOCAL_ASR_MODEL",
  "TRANSCRIPTION_LANGUAGE",
  "TRANSCRIPTION_DIARIZATION",
  "AUTO_TRANSCRIBE_INGEST",
  "OPENCHATCUT_SKILLS_DIR",
] as const;
export type KeyName = (typeof KEY_NAMES)[number];
const SETTABLE = new Set<string>(KEY_NAMES);

// Names whose VALUES may be sent to the browser (model ids / vendor routing — config,
// not credentials). Deliberately a separate explicit list rather than derived from
// KEY_NAMES: adding a key to the whitelist must never accidentally make it non-secret.
export const NON_SECRET_NAMES: ReadonlySet<string> = new Set([
  "AGENT_IMPORT_ROOTS",
  "PROXY_URL",
  "LLM_PROVIDER",
  "LLM_MODEL",
  "CODEX_MODEL",
  "CODEX_REASONING_EFFORT",
  "LLM_OPENAI_API_MODE",
  MODEL_CAPABILITY_OVERRIDES_KEY,
  "GEMINI_IMAGE_MODEL",
  "IMAGE_BASE_URL",
  "GEMINI_BASE_URL",
  "ELEVENLABS_TTS_MODEL",
  "OPENAI_TTS_MODEL",
  "GEMINI_TTS_MODEL",
  "MISTRAL_TTS_MODEL",
  "CARTESIA_TTS_MODEL",
  "OPENAI_TRANSCRIPTION_MODEL",
  "MISTRAL_TRANSCRIPTION_MODEL",
  "DEEPGRAM_TRANSCRIPTION_MODEL",
  "GROQ_TRANSCRIPTION_MODEL",
  "ELEVENLABS_TRANSCRIPTION_MODEL",
  "CARTESIA_TRANSCRIPTION_MODEL",
  "GROQ_BASE_URL",
  "TRANSCRIPTION_LANGUAGE",
  "TRANSCRIPTION_DIARIZATION",
  "AUTO_TRANSCRIBE_INGEST",
  "ELEVENLABS_SOUND_MODEL",
  "DOUBAO_TTS_RESOURCE_ID",
  "SEEDANCE_VIDEO_MODEL",
  "KLING_VIDEO_MODEL",
  "MUREKA_MUSIC_MODEL",
  "MINIMAX_TTS_MODEL",
  "MINIMAX_VIDEO_MODEL",
  "MINIMAX_MUSIC_MODEL",
  "MINIMAX_IMAGE_MODEL",
  "WAVESPEED_IMAGE_MODEL",
  "BYTEPLUS_IMAGE_MODEL",
  "BYTEPLUS_VIDEO_MODEL",
  "INWORLD_TTS_MODEL",
  "FISHAUDIO_TTS_MODEL",
  "SPEECHIFY_TTS_MODEL",
  "PREFERRED_IMAGE_VENDOR",
  "PREFERRED_VOICE_VENDOR",
  "PREFERRED_VIDEO_VENDOR",
  "PREFERRED_MUSIC_VENDOR",
  "PREFERRED_TRANSCRIPTION_PROVIDER",
  "LOCAL_ASR_MODEL",
  "R2_ENABLED", // Cloud synchronization switch ('' default = enabled, '0' = disabled) - configuration is not credentials
  "R2_PRESIGN", // Browser pre-signed direct transmission ('' default = enabled, '0' = server-side write-through only)
  "MEDIA_DIR", // Asset saving directory (local path, '' = default public/media/uploads) - configuration is not credentials
  "OPENCHATCUT_SKILLS_DIR", // User skill files directory ('' = ~/.openchatcut/skills) - configuration is not credentials
  ...LLM_PROVIDER_PRESETS.flatMap((preset) => {
    const names = llmProviderConfigNames(preset.id);
    return [names.baseUrl, names.model];
  }),
]);

const store = new Map<string, string>(); // current value per key (seed + runtime overrides)
const envSeeded = new Set<string>(); // which keys came from .env.local / process.env at startup

function normalizeStoredValue(name: string, raw: unknown): string {
  const value = String(raw ?? "").trim();
  return name === MODEL_CAPABILITY_OVERRIDES_KEY && value
    ? serializeModelCapabilityOverrides(parseModelCapabilityOverrides(decodePersistedEnvValue(value)))
    : value;
}

function seedLegacyModelCapabilities(env: Record<string, string>): void {
  if (store.has(MODEL_CAPABILITY_OVERRIDES_KEY)) return;
  const records: ModelCapabilityOverride[] = [];
  for (const preset of LLM_PROVIDER_PRESETS) {
    const names = llmProviderConfigNames(preset.id);
    const raw = (env[names.legacyContextWindow] ?? process.env[names.legacyContextWindow] ?? "").trim();
    const contextWindowTokens = Number(raw);
    if (!Number.isSafeInteger(contextWindowTokens)
      || contextWindowTokens < 4_096
      || contextWindowTokens > 4_000_000) continue;
    records.push({
      backend: "api",
      provider: preset.id,
      modelId: store.get(names.model) || preset.defaultModel,
      contextWindowTokens,
    });
  }
  if (records.length === 0) return;
  store.set(MODEL_CAPABILITY_OVERRIDES_KEY, serializeModelCapabilityOverrides(records));
  envSeeded.add(MODEL_CAPABILITY_OVERRIDES_KEY);
}

/** Seed the store from Vite's loaded env (+ process.env fallback). Call once at startup. */
export function seedKeystore(env: Record<string, string>): void {
  for (const name of KEY_NAMES) {
    const raw = env[name] ?? process.env[name] ?? "";
    try {
      const value = normalizeStoredValue(name, raw);
      if (!value) continue;
      store.set(name, value);
      envSeeded.add(name);
    } catch {
      if (name === MODEL_CAPABILITY_OVERRIDES_KEY) {
        store.delete(name);
        envSeeded.delete(name);
      }
    }
  }
  for (const [target, value] of planLegacyLlmMigration(
    (n) => store.has(n),
    (n) => store.get(n) ?? "",
  )) {
    store.set(target, value);
    envSeeded.add(target);
  }
  seedLegacyModelCapabilities(env);
}

/**
 * One-time compatibility migration plan (exported for verify). Old installs had
 * a single LLM tuple (LLM_API_KEY/BASE_URL/MODEL); attach it to the provider
 * that was active when those values were saved. Only migrate into a provider
 * slot with NO per-provider config at all: LLM_PROVIDER changes over time, and
 * grafting the legacy base URL onto a provider the user configured later (own
 * key, preset base) silently reroutes it to the old relay.
 */
export function planLegacyLlmMigration(
  has: (name: string) => boolean,
  get: (name: string) => string,
): Array<[string, string]> {
  const legacyProvider = normalizeLlmProvider(get("LLM_PROVIDER"));
  const names = llmProviderConfigNames(legacyProvider);
  if ([names.apiKey, names.baseUrl, names.model].some(has)) return [];
  const plan: Array<[string, string]> = [];
  const push = (target: string, value: string): void => {
    if (value) plan.push([target, value]);
  };
  push(names.apiKey, get("LLM_API_KEY"));
  push(
    names.baseUrl,
    has("LLM_BASE_URL")
      ? resolveLlmBaseUrl(
          legacyProvider,
          get("LLM_BASE_URL"),
          get("LLM_BASE_URL_FORMAT"),
        )
      : "",
  );
  push(names.model, get("LLM_MODEL"));
  return plan;
}

/** Live value for a key (runtime override wins over the .env.local seed). '' if unset. */
export function getKey(name: KeyName): string {
  return store.get(name) ?? "";
}

// Capability booleans derived from current key presence — SAME logic as the vite.config
// `define` snapshot, but computed live so the agent perceives runtime key changes.
export interface Caps {
  image: boolean;
  voice: boolean;
  video: boolean;
  music: boolean;
  sound: boolean;
  stock: boolean;
  transcription: boolean;
  sandbox: boolean;
  web: boolean;
  storage: boolean;
}
export function computeCaps(): Caps {
  const has = (n: KeyName): boolean => getKey(n).length > 0;
  return {
    image:
      has("IMAGE_API_KEY") ||
      has("OPENAI_API_KEY") ||
      has("GEMINI_API_KEY") ||
      has("MINIMAX_API_KEY") ||
      has("WAVESPEED_API_KEY") ||
      has("BYTEPLUS_API_KEY"),
    voice:
      (has("DOUBAO_TTS_APP_ID") && has("DOUBAO_TTS_ACCESS_KEY")) ||
      has("ELEVENLABS_API_KEY") ||
      has("MINIMAX_API_KEY") ||
      has("INWORLD_TTS_API_KEY") ||
      has("FISHAUDIO_TTS_API_KEY") ||
      has("SPEECHIFY_TTS_API_KEY") ||
      (getKey("PREFERRED_VOICE_VENDOR") === "openai" && has("OPENAI_API_KEY")) ||
      (getKey("PREFERRED_VOICE_VENDOR") === "gemini" && has("GEMINI_API_KEY")) ||
      (getKey("PREFERRED_VOICE_VENDOR") === "mistral" && has("LLM_MISTRAL_API_KEY")) ||
      (getKey("PREFERRED_VOICE_VENDOR") === "cartesia" && has("CARTESIA_API_KEY")),
    video:
      has("SEEDANCE_API_KEY") || has("KLING_API_KEY") || has("MINIMAX_API_KEY") || has("BYTEPLUS_API_KEY"),
    music: has("MUREKA_API_KEY") || has("MINIMAX_API_KEY"),
    sound: has("ELEVENLABS_API_KEY"),
    stock:
      has("PEXELS_API_KEY") ||
      has("PIXABAY_API_KEY") ||
      has("UNSPLASH_ACCESS_KEY") ||
      has("FREESOUND_API_KEY") ||
      has("FIRECRAWL_API_KEY"),
    transcription:
      getKey("PREFERRED_TRANSCRIPTION_PROVIDER") === "local" ||
      has("ASSEMBLYAI_API_KEY") ||
      (getKey("PREFERRED_TRANSCRIPTION_PROVIDER") === "openai" && has("OPENAI_API_KEY")) ||
      (getKey("PREFERRED_TRANSCRIPTION_PROVIDER") === "mistral" && has("LLM_MISTRAL_API_KEY")) ||
      (getKey("PREFERRED_TRANSCRIPTION_PROVIDER") === "deepgram" && has("DEEPGRAM_API_KEY")) ||
      (getKey("PREFERRED_TRANSCRIPTION_PROVIDER") === "groq" && has("GROQ_API_KEY")) ||
      (getKey("PREFERRED_TRANSCRIPTION_PROVIDER") === "elevenlabs" && has("ELEVENLABS_API_KEY")) ||
      (getKey("PREFERRED_TRANSCRIPTION_PROVIDER") === "cartesia" && has("CARTESIA_API_KEY")),
    sandbox: has("E2B_API_KEY"),
    web: has("FIRECRAWL_API_KEY"),
    storage:
      !isIsolatedDevProfile() &&
      has("R2_ACCOUNT_ID") &&
      has("R2_ACCESS_KEY_ID") &&
      has("R2_SECRET_ACCESS_KEY") &&
      has("R2_BUCKET") &&
      getKey("R2_ENABLED") !== "0",
  };
}

export interface KeyState {
  configured: boolean;
  source: "env" | "runtime" | "none";
}
export interface KeyStatus {
  keys: Record<string, KeyState>;
  caps: Caps;
  models: Record<string, string>;
}

/** Browser-facing status. SECURITY INVARIANT: a SECRET key's value (any name not in
 * NON_SECRET_NAMES) NEVER appears in this (or any) response — secrets surface as
 * booleans + source only. Non-secret model/routing values are echoed raw in `models`
 * ('' when unset); the `keys` boolean map still covers every whitelisted name. */
export function keyStatus(): KeyStatus {
  const keys: Record<string, KeyState> = {};
  const models: Record<string, string> = {};
  for (const name of KEY_NAMES) {
    const set = getKey(name).length > 0;
    keys[name] = {
      configured: set,
      source: set ? (envSeeded.has(name) ? "env" : "runtime") : "none",
    };
    if (NON_SECRET_NAMES.has(name)) models[name] = getKey(name);
  }
  return { keys, caps: computeCaps(), models };
}

/** Apply key edits from the settings UI: validate, update memory, persist to .env.local.
 * Empty value clears a key. Values containing newlines are rejected. Unknown names ignored. */
export async function setKeys(patch: Record<string, unknown>): Promise<void> {
  const clean = new Map<string, string>();
  for (const [name, raw] of Object.entries(patch)) {
    if (!SETTABLE.has(name)) continue; // whitelist
    const v = String(raw ?? "");
    if (/[\r\n]/.test(v))
      throw new Error(`invalid value for ${name}: no newlines allowed`);
    clean.set(name, normalizeStoredValue(name, v));
  }
  if (clean.size === 0) return;
  if (clean.has("LLM_BASE_URL") && !clean.has("LLM_BASE_URL_FORMAT")) {
    clean.set(
      "LLM_BASE_URL_FORMAT",
      clean.get("LLM_BASE_URL") ? AI_SDK_BASE_URL_FORMAT : "",
    );
  }
  const existing = await readFile(ENV_PATH, "utf8").catch(
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    },
  );
  const isolated = isIsolatedDevProfile(ACTIVE_PROFILE);
  const merged = mergeEnvText(existing, clean, isolated);
  await atomicWriteFile(ENV_PATH, merged, { mode: 0o600 });
  for (const [name, v] of clean) {
    if (v) {
      store.set(name, v);
      envSeeded.delete(name);
    } // now a runtime value
    else store.delete(name);
  }
}
