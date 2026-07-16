// Which key-gated capabilities are actually configured. The booleans are computed
// SERVER-SIDE in vite.config.ts (from .env.local) and injected via `define` as
// __CONFIGURED_CAPS__ — BOOLEANS ONLY, never any key value reaches the browser.
// The system prompt reads this so the agent plans around what's available instead
// of promising e.g. 生图 and only discovering "not configured" mid-execution.

export type CapabilityKey =
  | 'image' | 'voice' | 'video' | 'music' | 'sound'
  | 'stock' | 'transcription' | 'sandbox' | 'web';

// Injected by Vite `define`. Undefined outside Vite (tsx checks) → all-false fallback.
declare const __CONFIGURED_CAPS__: Record<CapabilityKey, boolean> | undefined;

const ALL_OFF: Record<CapabilityKey, boolean> = {
  image: false, voice: false, video: false, music: false, sound: false,
  stock: false, transcription: false, sandbox: false, web: false,
};

export const CONFIGURED_CAPS: Record<CapabilityKey, boolean> =
  typeof __CONFIGURED_CAPS__ !== 'undefined' ? __CONFIGURED_CAPS__ : ALL_OFF;

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
export function capabilitiesPrompt(caps: Record<CapabilityKey, boolean> = CONFIGURED_CAPS): string {
  const on: string[] = [];
  const off: string[] = [];
  for (const r of CAP_ROWS) {
    if (caps[r.key]) on.push(`${r.label}(${r.tool})`);
    else off.push(`${r.label}(${r.tool})——${r.fallback}`);
  }
  return `\n\n# 当前可用能力（按已配置的 API key，local 剪辑不吃 key 恒可用）\n`
    + `✅ 已配置可用：${on.length ? on.join('、') : '（无 key 类能力）'}。\n`
    + `⬜ 未配置——别在计划里承诺、别调用（调用会返回「not configured」错误，白费一轮）：\n`
    + (off.length ? off.map((s) => `  - ${s}`).join('\n') : '  （无）')
    + `\n需要未配置的能力时，按上面每条的替代方案走，或直接告诉用户"该能力未接入"。`;
}
