// Which key-gated capabilities are actually configured. The booleans are computed
// SERVER-SIDE in vite.config.ts (from .env.local) and injected via `define` as
// __CONFIGURED_CAPS__ — BOOLEANS ONLY, never any key value reaches the browser.
// The system prompt reads this so the agent plans around what's available instead
// of promising e.g. raw graph and only discovering "not configured" mid-execution.

export type CapabilityKey =
  | 'image' | 'voice' | 'video' | 'music' | 'sound'
  | 'stock' | 'transcription' | 'sandbox' | 'web';

const ALL_OFF: Record<CapabilityKey, boolean> = {
  image: false, voice: false, video: false, music: false, sound: false,
  stock: false, transcription: false, sandbox: false, web: false,
};

// __CONFIGURED_CAPS__ is a Vite-`define` global (declared in src/globals.d.ts);
// undefined under tsx → all-false fallback. The typeof guard keeps the undefined
// case safe (a bare reference would ReferenceError outside Vite).
export const CONFIGURED_CAPS: Record<CapabilityKey, boolean> =
  typeof __CONFIGURED_CAPS__ !== 'undefined' ? (__CONFIGURED_CAPS__ as Record<CapabilityKey, boolean>) : ALL_OFF;

// Live capability snapshot from the server (GET /api/keys → caps), applied at app load and
// after the settings UI saves a key — so the agent perceives a runtime key change on its next
// message, without a dev-server restart (__CONFIGURED_CAPS__ is only the startup snapshot).
// Wins over the define once set.
let liveCaps: Record<CapabilityKey, boolean> | null = null;
export function applyLiveCaps(caps: Partial<Record<CapabilityKey, boolean>>): void {
  liveCaps = { ...ALL_OFF, ...caps };
}
export function currentCaps(): Record<CapabilityKey, boolean> {
  return liveCaps ?? CONFIGURED_CAPS;
}

// Per-KEY live status (GET /api/keys → keys, booleans only) — refines the manifest to
// VENDOR granularity: with it the agent knows e.g. "video is on via model=kling", instead
// of guessing an enum value, calling an unconfigured provider, and burning a round on the
// "not configured" error. Absent (startup define only) → capability-level manifest.
let liveKeys: Record<string, { configured: boolean }> | null = null;
export function applyLiveKeyStatus(keys: Record<string, { configured: boolean }>): void {
  liveKeys = keys;
}

// Non-secret model/routing values from the server (GET /api/keys → models): the
// per-vendor model picks plus PREFERRED_*_VENDOR — the user's default vendor per
// capability ('' = not chosen → agent must ASK in chat before first use).
let liveModels: Record<string, string> | null = null;
export function applyLiveModels(models: Record<string, string>): void {
  liveModels = models;
}

// Which vendors light up a capability: `arg` is the EXACT tool-arg value that selects
// the vendor (and what PREFERRED_*_VENDOR stores); `need` = OR of AND-groups of key
// names (mirrors keystore computeCaps).
interface ProviderRow { label: string; arg: string; argKey: 'model' | 'provider'; need: string[][] }
const CAP_PROVIDERS: Partial<Record<CapabilityKey, ProviderRow[]>> = {
  image: [
    { label: 'gpt-image', arg: 'gpt-image-2', argKey: 'model', need: [['IMAGE_API_KEY'], ['OPENAI_API_KEY']] },
    { label: 'Nano Banana', arg: 'nano-banana', argKey: 'model', need: [['GEMINI_API_KEY']] },
    { label: 'MiniMax', arg: 'image-01', argKey: 'model', need: [['MINIMAX_API_KEY']] },
  ],
  voice: [
    { label: 'ElevenLabs', arg: 'elevenlabs', argKey: 'provider', need: [['ELEVENLABS_API_KEY']] },
    { label: 'bean bag', arg: 'doubao', argKey: 'provider', need: [['DOUBAO_TTS_APP_ID', 'DOUBAO_TTS_ACCESS_KEY']] },
    { label: 'MiniMax', arg: 'minimax', argKey: 'provider', need: [['MINIMAX_API_KEY']] },
  ],
  video: [
    { label: 'Seedance', arg: 'seedance2', argKey: 'model', need: [['SEEDANCE_API_KEY']] },
    { label: 'Ke Ling', arg: 'kling', argKey: 'model', need: [['KLING_API_KEY']] },
    { label: 'conch', arg: 'hailuo', argKey: 'model', need: [['MINIMAX_API_KEY']] },
  ],
  music: [
    { label: 'Mureka', arg: 'mureka', argKey: 'provider', need: [['MUREKA_API_KEY']] },
    { label: 'MiniMax', arg: 'minimax', argKey: 'provider', need: [['MINIMAX_API_KEY']] },
  ],
  stock: [
    { label: 'Pexels', arg: 'pexels', argKey: 'provider', need: [['PEXELS_API_KEY']] },
    { label: 'Pixabay', arg: 'pixabay', argKey: 'provider', need: [['PIXABAY_API_KEY']] },
    { label: 'Unsplash', arg: 'unsplash', argKey: 'provider', need: [['UNSPLASH_ACCESS_KEY']] },
    { label: 'Freesound', arg: 'freesound', argKey: 'provider', need: [['FREESOUND_API_KEY']] },
  ],
};

const PREFERRED_KEY: Partial<Record<CapabilityKey, string>> = {
  image: 'PREFERRED_IMAGE_VENDOR', voice: 'PREFERRED_VOICE_VENDOR',
  video: 'PREFERRED_VIDEO_VENDOR', music: 'PREFERRED_MUSIC_VENDOR',
};

const rowTag = (r: ProviderRow): string => `${r.label}(${r.argKey}=${r.arg})`;

/** Routing suffix for an ON capability: user default → use it; single vendor → use it;
 * several & no default → agent must ask the user (once) before first use. */
function providerSuffix(cap: CapabilityKey): string {
  const rows = CAP_PROVIDERS[cap];
  if (!rows || !liveKeys) return '';
  const has = (n: string): boolean => Boolean(liveKeys?.[n]?.configured);
  const on = rows.filter((r) => r.need.some((group) => group.every(has)));
  if (on.length === 0) return '';
  const prefKey = PREFERRED_KEY[cap];
  const pref = prefKey ? (liveModels?.[prefKey] ?? '').trim() : '';
  const chosen = pref ? on.find((r) => r.arg === pref) : undefined;
  if (chosen) return `·User default: ${rowTag(chosen)}——Use it directly,Don't ask again`;
  if (on.length === 1) return `·Available: ${rowTag(on[0])}——Use directly`;
  const names = on.map(rowTag).join('、');
  if (!prefKey) return `·Available: ${names}`;
  return `·Available: ${names}——The user has not set a default:Before using this ability for the first time in this session,Use first ask_followup_questions Select one,Inherit selected`;
}

// label + the primary tool + a fallback hint when the capability is off.
const CAP_ROWS: { key: CapabilityKey; label: string; tool: string; fallback: string }[] = [
  { key: 'image', label: 'raw picture', tool: 'submit_image', fallback: 'Use instead push_asset/import_url_asset Import images from the public network or let users upload them/Paste' },
  { key: 'voice', label: 'dubbing/TTS', tool: 'submit_voice', fallback: 'Let users prepare and upload their own/Paste audio' },
  { key: 'video', label: 'raw video', tool: 'submit_video', fallback: 'Use instead push_asset Import public network videos or let users upload them' },
  { key: 'music', label: 'live music', tool: 'submit_music', fallback: 'Use library instead list_audio/add_audio, or let users upload' },
  { key: 'sound', label: 'Sound effect generation', tool: 'submit_sound', fallback: 'Use library sound effects instead list_audio/add_audio' },
  { key: 'stock', label: 'Online gallery search', tool: 'search_stock_media', fallback: 'Use instead push_asset Directly import known public networks URL' },
  { key: 'transcription', label: 'Transcribe/oral clip', tool: 'transcribe_track', fallback: 'Unable to delete words at word level/Clear your mouth/automatic subtitles' },
  { key: 'sandbox', label: 'sandbox execution(ffmpeg/node/python)', tool: 'run_code', fallback: 'skip probe_media Wait for sandbox steps' },
  { key: 'web', label: 'web scraping', tool: 'web_browser', fallback: 'Please paste the web page content directly' },
];

/** System-prompt section listing which key-gated tools are on/off (local editing —
 * templates/effects/transitions/zoom/etc. — never needs a key and is always on). */
export function capabilitiesPrompt(caps: Record<CapabilityKey, boolean> = currentCaps()): string {
  const on: string[] = [];
  const off: string[] = [];
  for (const r of CAP_ROWS) {
    if (caps[r.key]) on.push(`${r.label}(${r.tool}${providerSuffix(r.key)})`);
    else off.push(`${r.label}(${r.tool})——${r.fallback}`);
  }
  return `\n\n# Currently available capabilities (by configured API key，local Clips don’t eat key always available)\n`
    + `✅ Configured and available:${on.length ? on.join('、') : '(none key class ability)'}。\n`
    + `⬜ Not configured - don't commit in the plan, don't call (the call will return "not configured"Error, wasted round):\n`
    + (off.length ? off.map((s) => `  - ${s}`).join('\n') : '  (none)')
    + `\nWhen unconfigured capabilities are needed, follow each of the alternatives above, or tell the user directly"This capability is not connected"。`;
}
