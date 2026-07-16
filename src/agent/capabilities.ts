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

// Which vendors light up a capability, and the EXACT tool arg to select each one.
// `need` = OR of AND-groups of key names (mirrors keystore computeCaps).
const CAP_PROVIDERS: Partial<Record<CapabilityKey, { label: string; need: string[][] }[]>> = {
  image: [
    { label: 'gpt-image(model=gpt-image-2)', need: [['IMAGE_API_KEY'], ['OPENAI_API_KEY']] },
    { label: 'Nano Banana(model=nano-banana)', need: [['GEMINI_API_KEY']] },
    { label: 'MiniMax(model=image-01)', need: [['MINIMAX_API_KEY']] },
  ],
  voice: [
    { label: 'ElevenLabs(provider=elevenlabs)', need: [['ELEVENLABS_API_KEY']] },
    { label: '豆包(provider=doubao)', need: [['DOUBAO_TTS_APP_ID', 'DOUBAO_TTS_ACCESS_KEY']] },
    { label: 'MiniMax(provider=minimax)', need: [['MINIMAX_API_KEY']] },
  ],
  video: [
    { label: 'Seedance(model=seedance2)', need: [['SEEDANCE_API_KEY']] },
    { label: '可灵(model=kling)', need: [['KLING_API_KEY']] },
    { label: '海螺(model=hailuo)', need: [['MINIMAX_API_KEY']] },
  ],
  music: [
    { label: 'Mureka(provider=mureka)', need: [['MUREKA_API_KEY']] },
    { label: 'MiniMax(provider=minimax)', need: [['MINIMAX_API_KEY']] },
  ],
  stock: [
    { label: 'Pexels', need: [['PEXELS_API_KEY']] },
    { label: 'Pixabay', need: [['PIXABAY_API_KEY']] },
  ],
};

/** '·可用: A、B' suffix for an ON capability — '' when key detail is unknown. */
function providerSuffix(cap: CapabilityKey): string {
  const rows = CAP_PROVIDERS[cap];
  if (!rows || !liveKeys) return '';
  const has = (n: string): boolean => Boolean(liveKeys?.[n]?.configured);
  const on = rows.filter((r) => r.need.some((group) => group.every(has))).map((r) => r.label);
  return on.length ? `·可用: ${on.join('、')}` : '';
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
