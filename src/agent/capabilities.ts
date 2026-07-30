// Which key-gated capabilities are actually configured. The booleans are computed
// SERVER-SIDE in vite.config.ts (from .env.local) and injected via `define` as
// __CONFIGURED_CAPS__ — BOOLEANS ONLY, never any key value reaches the browser.
// The system prompt reads this so the agent plans around what's available instead
// of promising e.g. 生图 and only discovering "not configured" mid-execution.

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
    { label: '豆包', arg: 'doubao', argKey: 'provider', need: [['DOUBAO_TTS_APP_ID', 'DOUBAO_TTS_ACCESS_KEY']] },
    { label: 'MiniMax', arg: 'minimax', argKey: 'provider', need: [['MINIMAX_API_KEY']] },
  ],
  video: [
    { label: 'Seedance', arg: 'seedance2', argKey: 'model', need: [['SEEDANCE_API_KEY']] },
    { label: '可灵', arg: 'kling', argKey: 'model', need: [['KLING_API_KEY']] },
    { label: '海螺', arg: 'hailuo', argKey: 'model', need: [['MINIMAX_API_KEY']] },
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
  if (chosen) return `·用户默认: ${rowTag(chosen)}——直接用它,勿再询问`;
  if (on.length === 1) return `·可用: ${rowTag(on[0])}——直接用`;
  const names = on.map(rowTag).join('、');
  if (!prefKey) return `·可用: ${names}`;
  return `·可用: ${names}——用户未设默认:本会话首次用该能力前,先用 ask_followup_questions 单选一家,之后沿用所选`;
}

// label + the primary tool + a fallback hint when the capability is off.
const CAP_ROWS: { key: CapabilityKey; label: string; tool: string; fallback: string }[] = [
  { key: 'image', label: '生图', tool: 'submit_image', fallback: '改用 push_asset/import_url_asset 导入公网图片，或让用户上传/粘贴' },
  { key: 'voice', label: '配音/TTS', tool: 'submit_voice', fallback: '让用户自备并上传/粘贴音频' },
  { key: 'video', label: '生视频', tool: 'submit_video', fallback: '改用 push_asset 导入公网视频，或让用户上传' },
  { key: 'music', label: '生音乐', tool: 'submit_music', fallback: '改用库内 list_audio/add_audio，或让用户上传' },
  { key: 'sound', label: '音效生成', tool: 'submit_sound', fallback: '改用库内音效 list_audio/add_audio' },
  { key: 'stock', label: '在线图库搜索', tool: 'search_stock_media', fallback: '改用 push_asset 直接导入已知公网 URL' },
  { key: 'transcription', label: '转写/口播剪辑', tool: 'transcribe_track', fallback: '无法做词级删词/清口水/自动字幕' },
  { key: 'sandbox', label: '沙箱执行(ffmpeg/node/python)', tool: 'run_code', fallback: '跳过 probe_media 等沙箱步骤' },
  { key: 'web', label: '网页抓取', tool: 'web_browser', fallback: '请用户直接粘贴网页内容' },
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
  return `\n\n# 当前可用能力（按已配置的 API key，local 剪辑不吃 key 恒可用）\n`
    + `✅ 已配置可用：${on.length ? on.join('、') : '（无 key 类能力）'}。\n`
    + `⬜ 未配置——别在计划里承诺、别调用（调用会返回「not configured」错误，白费一轮）：\n`
    + (off.length ? off.map((s) => `  - ${s}`).join('\n') : '  （无）')
    + `\n需要未配置的能力时，按上面每条的替代方案走，或直接告诉用户"该能力未接入"。`;
}
