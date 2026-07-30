import type { AgentContext } from '../context';
import type { CaptionsData, CaptionTemplate, CaptionPacing, CaptionAnchor, CaptionLayout, CaptionWordOverride } from '../../captions/types';
import { CAPTION_STYLES, CAPTION_STYLE_BY_ID } from '../../captions/styles';
import { mapCaptionStyle } from '../../captions/styleMap';
import { sourceList, sourceSet, sourceAdd, sourceRemove, languageMode, bilingual, firstTranscribedOnTrack } from './captions-sources';
import { execLayoutPolicy, execPositions, execSourceUpdate } from './captions-lanes';
import { listCaptionPresets, saveCaptionPreset, deleteCaptionPreset, resolveCaptionPreset, type CaptionPreset } from '../../captions/presetStore';
import { captionsOnTrack, defaultTrackId, resolveTrackId, timelineTrackIds, trackAlias } from '../../editor/types';

// edit_captions uses one tool with a 21-action dispatcher. Most action data
// arrives as a JSON string in `json`. Backed by OpenChatCut's captions overlay
// (enable/template/style/layout/display overrides/multi-source/translation).
// 多车道三兄弟(layout_policy / positions / source_update)在 captions-lanes.ts,
// 数据模型 = CaptionsData.sourceEntries(每 source 一条渲染车道)。

type Args = Record<string, unknown>;
type Result = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const orderNum = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  return undefined;
};

/** Action data usually arrives as a JSON string in `json`; raw objects are also accepted. */
function parseJson(args: Args): Record<string, unknown> {
  const j = args.json;
  if (j && typeof j === 'object') return j as Record<string, unknown>;
  if (typeof j === 'string' && j.trim()) {
    try { const o = JSON.parse(j); return o && typeof o === 'object' ? o : {}; } catch { return {}; }
  }
  return {};
}

const isTemplate = (id: string): id is CaptionTemplate => id in CAPTION_STYLE_BY_ID;

const ANCHORS = new Set<CaptionAnchor>(['top', 'center', 'bottom', 'top-left', 'top-center', 'top-right', 'middle-left', 'middle-center', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right']);

/** action=layout json → CaptionLayout (anchor preset + ratio offsets; px top/left → ratio). */
function toLayout(json: Record<string, unknown>, width: number, height: number): CaptionLayout | null {
  const l: CaptionLayout = {};
  const preset = str(json.preset) || str(json.anchor);
  if (preset) { if (!ANCHORS.has(preset as CaptionAnchor)) return null; l.anchor = preset as CaptionAnchor; }
  const oxr = num(json.offsetXRatio); if (oxr !== undefined) l.offsetXRatio = oxr;
  const oyr = num(json.offsetYRatio); if (oyr !== undefined) l.offsetYRatio = oyr;
  // pixel top/left → approximate anchor + offset from the top-left
  const top = num(json.top); if (top !== undefined && height > 0) { l.anchor = l.anchor ?? 'top-center'; l.offsetYRatio = top / height; }
  const left = num(json.left); if (left !== undefined && width > 0) { l.offsetXRatio = (left - width / 2) / width; }
  return Object.keys(l).length ? l : null;
}

/** display_text: per-word overrides (hide / retext / force break) + clearOverrides. */
function displayText(json: Record<string, unknown>, c: CaptionsData, ctx: AgentContext, s: { items: { id: string; transcript?: unknown[] }[] }): Result {
  if (json.clearOverrides === true || json.clear_overrides === true) {
    ctx.commands.updateCaptions({ wordOverrides: {} });
    return { ok: true, cleared: true };
  }
  const raw = json.overrides;
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'display_text needs {overrides:[{wordIndex,...}]} or {clearOverrides:true}' };
  const item = c.sourceItemId ? s.items.find((it) => it.id === c.sourceItemId) : undefined;
  const total = item?.transcript?.length ?? c.words?.length ?? 0;
  const next: Record<number, CaptionWordOverride> = { ...(c.wordOverrides ?? {}) };
  const ignored: string[] = [];
  const errors: string[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') { errors.push('non-object entry'); continue; }
    const e = entry as Record<string, unknown>;
    if (e.key !== undefined && e.wordIndex === undefined) { ignored.push('key (this build keys word overrides by wordIndex from read_captions)'); continue; }
    if ('keepWithPrevious' in e) ignored.push('keepWithPrevious');
    const wi = e.wordIndex;
    if (typeof wi !== 'number' || !Number.isInteger(wi) || wi < 0) { errors.push(`invalid wordIndex ${JSON.stringify(wi)}`); continue; }
    if (total > 0 && wi >= total) { errors.push(`wordIndex ${wi} out of range (0..${total - 1})`); continue; }
    if (e.clear === true) { delete next[wi]; continue; }
    const patch: CaptionWordOverride = {};
    if (typeof e.hidden === 'boolean') patch.hidden = e.hidden;
    if (typeof e.text === 'string') patch.text = e.text;
    if (e.text === null && next[wi]) delete next[wi].text; // clearing a never-overridden word is a no-op, not a crash
    if (typeof e.forcePageBreak === 'boolean') patch.forceBreak = e.forcePageBreak;
    else if (typeof e.forceBreak === 'boolean') patch.forceBreak = e.forceBreak;
    if (Object.keys(patch).length) next[wi] = { ...next[wi], ...patch };
  }
  ctx.commands.updateCaptions({ wordOverrides: next });
  return { ok: true, overrides: Object.keys(next).length, ...(ignored.length ? { ignored } : {}), ...(errors.length ? { errors } : {}) };
}

/** preset_apply/rename/delete resolve a saved preset by presetId (or presetName). */
async function findPreset(args: Args, json: Record<string, unknown>): Promise<CaptionPreset | undefined> {
  const q = str(args.presetId) || str(json.presetId) || str(json.id) || str(args.presetName) || str(json.presetName) || str(json.name);
  return q ? resolveCaptionPreset(q) : undefined;
}

export async function editCaptions(args: Args, ctx: AgentContext): Promise<Result> {
  const action = str(args.action);
  if (!action) return { error: 'edit_captions needs an action' };
  const s = ctx.getState();
  const requested = str(args.captionTrackId) || str(args.captionsItemId);
  const target = requested ? resolveTrackId(s, requested, 'caption') : defaultTrackId(s, 'caption');
  if (requested && !target) return { error: `no caption track ${requested}` };
  const c = target ? captionsOnTrack(s, target) : s.captions ?? null;
  if (target) {
    const commands = ctx.commands;
    ctx = {
      ...ctx,
      commands: {
        ...commands,
        setCaptions: (captions) => commands.setCaptions(captions, target),
        updateCaptions: (patch) => commands.updateCaptions(patch, target),
      },
    };
  }
  const json = parseJson(args);

  // ── template: list built-ins (no arg) or apply one — works with captions off ──
  if (action === 'template') {
    const pick = str(args.templatePreset) || str(args.preset);
    if (!pick) return { ok: true, presets: CAPTION_STYLES.map((p) => ({ id: p.id, name: p.label, nameZh: p.labelZh, styleProfile: p.hint })) };
    if (!isTemplate(pick)) return { error: `unknown caption preset "${pick}"`, presets: CAPTION_STYLES.map((p) => p.id) };
    if (!c) return { error: 'captions are off; action=enable first' };
    ctx.commands.updateCaptions({ template: pick }); // size/position preserved (styleOverride/layout untouched)
    return { ok: true, template: pick };
  }

  // ── lifecycle ──
  if (action === 'enable') {
    const transcribed = s.items.filter((it) => (it.transcript?.length ?? 0) > 0);
    if (!c && !transcribed.length) return { error: 'no transcript to caption; run transcribe_track first' };
    const presetArg = str(args.preset);
    const template: CaptionTemplate = presetArg && presetArg !== 'auto' && isTemplate(presetArg) ? presetArg : (c?.template ?? 'plain');
    const pacing: CaptionPacing = c?.pacing ?? 'phrase';
    const base: CaptionsData = { ...(c ?? {}), enabled: true, template, pacing };
    if (!c?.sourceItemId && !c?.sources && transcribed[0]) base.sourceItemId = transcribed[0].id;
    if (c) ctx.commands.updateCaptions(base); else ctx.commands.setCaptions(base);
    return { ok: true, enabled: true, template, pacing, note: 'captions read the anchored source; for ALL audible tracks use action=source_set {mode:"timeline"}.' };
  }
  if (action === 'disable') {
    if (c) ctx.commands.updateCaptions({ enabled: false });
    return { ok: true, enabled: false };
  }

  if (!c) return { error: `captions are off; action=enable first (then ${action})` };

  // ── style / layout / display / track ──
  if (action === 'style') {
    const { styleOverride, pacing, ignored } = mapCaptionStyle(json, s.height);
    const patch: Partial<CaptionsData> = { styleOverride: { ...(c.styleOverride ?? {}), ...styleOverride } };
    if (pacing) patch.pacing = pacing;
    if (!Object.keys(styleOverride).length && !pacing) return { error: 'style needs at least one recognized field in json', ...(ignored.length ? { ignored } : {}) };
    ctx.commands.updateCaptions(patch);
    return { ok: true, applied: Object.keys(styleOverride), ...(pacing ? { pacing } : {}), ...(ignored.length ? { ignored } : {}) };
  }
  if (action === 'layout') {
    const layout = toLayout(json, s.width, s.height);
    if (!layout) return { error: 'layout 移动整块字幕,参数例:{"preset":"bottom-center"}(3×3 锚点/top/bottom/center)或 {"offsetXRatio":0.1,"offsetYRatio":-0.05} 微调;要把多条字幕分开摆(如英文上/中文下)用 action=positions,不是 layout' };
    ctx.commands.updateCaptions({ layout });
    return { ok: true, layout };
  }
  if (action === 'display_text') return displayText(json, c, ctx, s);
  if (action === 'track') {
    const trackIds = timelineTrackIds(s);
    if (args.list === true) {
      return {
        ok: true,
        tracks: trackIds.map((id, trackOrder) => ({
          trackOrder,
          trackId: trackAlias(s, id),
          id,
          hasTranscript: s.items.some((item) => item.track === id && (item.transcript?.length ?? 0) > 0),
        })),
      };
    }
    const requestedOrder = args.trackOrder === undefined ? undefined : orderNum(args.trackOrder);
    if (args.trackOrder !== undefined && requestedOrder === undefined) return { error: 'trackOrder must be a non-negative 0-based integer' };
    const requestedTrack = str(args.trackId);
    const stableTrackId = requestedTrack
      ? resolveTrackId(s, requestedTrack)
      : requestedOrder === undefined ? null : trackIds[requestedOrder] ?? null;
    if (!stableTrackId) {
      return { error: requestedOrder === undefined
        ? 'track needs trackId or trackOrder (or list:true). To choose visible caption text, prefer source_set.'
        : `trackOrder ${requestedOrder} out of range (0..${Math.max(0, trackIds.length - 1)})` };
    }
    const it = firstTranscribedOnTrack(s, stableTrackId);
    if (!it) return { error: `no transcribed clip on track ${trackAlias(s, stableTrackId)}` };
    ctx.commands.updateCaptions({ sourceItemId: it.id, sources: undefined, sourceMode: 'item' });
    return { ok: true, trackId: trackAlias(s, stableTrackId), trackOrder: trackIds.indexOf(stableTrackId), sourceItemId: it.id };
  }

  // ── multi-source + language (delegated) ──
  if (action === 'layout_policy') return execLayoutPolicy(json, c, ctx);
  if (action === 'positions') return execPositions(json, c, ctx, s);
  if (action === 'source_update') return execSourceUpdate(json, c, ctx, s);
  if (action === 'source_list') return sourceList(c, s);
  if (action === 'source_set') return sourceSet(json, c, ctx, s);
  if (action === 'source_add') return sourceAdd(json, c, ctx, s);
  if (action === 'source_remove') return sourceRemove(json, c, ctx, s);
  if (action === 'language_mode') return languageMode(json, c, ctx, s);
  if (action === 'bilingual') return bilingual(json, c, ctx, s);

  // ── IDB-backed user style presets: save/apply/list/rename/delete ─────────
  if (action === 'preset_save') {
    const name = str(args.presetName) || str(json.name) || str(json.presetName);
    if (!name) return { error: 'preset_save needs presetName (or json.name)' };
    const preset: CaptionPreset = {
      id: `cp_${crypto.randomUUID()}`,
      name,
      template: c.template,
      styleOverride: c.styleOverride,
      pacing: c.pacing,
      createdAt: Date.now(),
    };
    await saveCaptionPreset(preset);
    return { ok: true, presetId: preset.id, name, captured: { template: c.template, styleFields: Object.keys(c.styleOverride ?? {}) } };
  }
  if (action === 'preset_list') {
    const presets = await listCaptionPresets();
    return { ok: true, presets: presets.map((p) => ({ id: p.id, name: p.name, template: p.template })) };
  }
  if (action === 'preset_apply') {
    const preset = await findPreset(args, json);
    if (!preset) return { error: 'preset_apply needs presetId or presetName of a saved preset (see preset_list)' };
    ctx.commands.updateCaptions({
      template: preset.template ?? c.template,
      styleOverride: preset.styleOverride ?? {},
      ...(preset.pacing ? { pacing: preset.pacing } : {}),
    });
    return { ok: true, applied: preset.name, presetId: preset.id, template: preset.template };
  }
  if (action === 'preset_rename') {
    const preset = await findPreset(args, json);
    if (!preset) return { error: 'preset_rename needs presetId (see preset_list)' };
    const name = str(args.newName) || str(json.newName) || str(json.name);
    if (!name) return { error: 'preset_rename needs a new name (newName / json.name)' };
    await saveCaptionPreset({ ...preset, name });
    return { ok: true, presetId: preset.id, name };
  }
  if (action === 'preset_delete') {
    const preset = await findPreset(args, json);
    if (!preset) return { error: 'preset_delete needs presetId (see preset_list)' };
    await deleteCaptionPreset(preset.id);
    return { ok: true, deleted: preset.name, presetId: preset.id };
  }


  return { error: `unknown action "${action}"` };
}
