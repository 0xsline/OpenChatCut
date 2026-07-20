import type { AgentContext } from '../context';
import type { CaptionAnchor, CaptionLayoutPolicy, CaptionPerSource, CaptionSlot, CaptionsData, CaptionSourceEntry } from '../../captions/types';
import { mapCaptionStyle } from '../../captions/styleMap';
import { CAPTION_STYLE_BY_ID } from '../../captions/styles';
import type { CaptionTemplate } from '../../captions/types';
import { findVariantByLang } from '../../transcript/variants';
import { resolveTrackId, type TimelineState } from '../../editor/types';

// edit_captions 多车道工具组：
// - positions      一次调用把多个 source 各就各位(同锚点=同块堆叠)
// - layout_policy  single-lane / auto-stack / manual-slots + perSource 覆盖
// - source_update  按选择器改单个 source 的可见性/锚点/槽位/样式/变体
// 数据落 CaptionsData.sourceEntries / layoutPolicy / perSource(captions/types.ts),
// 渲染由 captions/lanes.ts 引擎消费。

type Result = Record<string, unknown>;
type Json = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const ANCHORS = new Set<string>([
  'top', 'center', 'bottom',
  'top-left', 'top-center', 'top-right',
  'middle-left', 'middle-center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]);

let seq = 0;
const laneId = (): string => `src_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

/** 现 scope 提升为 sourceEntries(已有则拷贝;旧 sources[]/sourceItemId/timeline 一次性升级)。 */
export function ensureEntries(c: CaptionsData, s: TimelineState): CaptionSourceEntry[] {
  if (c.sourceEntries?.length) return c.sourceEntries.map((e) => ({ ...e }));
  const transcribed = (id: string) => s.items.some((it) => it.id === id && (it.transcript?.length ?? 0) > 0);
  if (c.sources?.length) return c.sources.filter(transcribed).map((itemId) => ({ id: laneId(), itemId }));
  if (c.sourceMode === 'timeline') {
    return s.items
      .filter((it) => (it.transcript?.length ?? 0) > 0)
      .sort((a, b) => a.startFrame - b.startFrame || a.id.localeCompare(b.id))
      .map((it) => ({ id: laneId(), itemId: it.id }));
  }
  if (c.sourceItemId && transcribed(c.sourceItemId)) return [{ id: laneId(), itemId: c.sourceItemId }];
  return [];
}

/** 选择器 → 命中的 entry 下标(selector 家族:index/id/sourceId/itemId/trackId/assetId/label/variant/slotId)。 */
export function matchEntries(entries: CaptionSourceEntry[], sel: Json, s: TimelineState): number[] | { error: string } {
  const idx = num(sel.index);
  if (idx !== undefined) {
    if (idx < 0 || idx >= entries.length) return { error: `index ${idx} out of range (0..${entries.length - 1})` };
    return [idx];
  }
  if (str(sel.speakerId)) return { error: 'speakerId selector 不支持:无 per-speaker 车道,请按轨/按 item 选择' };
  const id = str(sel.sourceId) || str(sel.id);
  if (id) {
    const hits = entries.flatMap((e, i) => (e.id === id ? [i] : []));
    return hits.length ? hits : { error: `no source with id "${id}" (source_list 查 sourceId)` };
  }
  const slotId = str(sel.slotId);
  if (slotId) {
    const hits = entries.flatMap((e, i) => (e.slotId === slotId ? [i] : []));
    return hits.length ? hits : { error: `no source pinned to slot "${slotId}"` };
  }
  const label = str(sel.label);
  if (label) {
    const hits = entries.flatMap((e, i) => (e.label === label ? [i] : []));
    return hits.length ? hits : { error: `no source labeled "${label}"` };
  }
  const variant = sel.variant && typeof sel.variant === 'object' ? (sel.variant as Json) : undefined;
  if (variant) {
    const lang = str(variant.languageCode);
    const hits = entries.flatMap((e, i) => (e.variant && (!lang || e.variant.languageCode === lang) ? [i] : []));
    return hits.length ? hits : { error: `no translation-variant source${lang ? ` for "${lang}"` : ''}` };
  }
  const itemId = str(sel.itemId);
  if (itemId) {
    const hits = entries.flatMap((e, i) => (e.itemId === itemId || e.itemId.startsWith(itemId) ? [i] : []));
    return hits.length ? hits : { error: `no source on item "${itemId}"` };
  }
  const assetId = str(sel.assetId);
  if (assetId) {
    const item = s.items.find((it) => it.src === assetId || it.templateId === assetId);
    const hits = item ? entries.flatMap((e, i) => (e.itemId === item.id ? [i] : [])) : [];
    return hits.length ? hits : { error: `no source for asset "${assetId}"` };
  }
  const track = str(sel.trackId) || str(sel.track);
  if (track) {
    const tid = resolveTrackId(s, track) ?? track;
    const onTrack = new Set(s.items.filter((it) => it.track === tid).map((it) => it.id));
    const hits = entries.flatMap((e, i) => (onTrack.has(e.itemId) ? [i] : []));
    return hits.length ? hits : { error: `no source on track "${track}"` };
  }
  return { error: '缺选择器:每条要带 index / sourceId / trackId / itemId / label / variant 之一定位车道,例 {"index":0} 或 {"trackId":"A2"} 或 {"variant":{"languageCode":"en"}};sourceId 用 source_list 查' };
}

const entrySummary = (e: CaptionSourceEntry, i: number) => ({
  index: i, sourceId: e.id, itemId: e.itemId,
  ...(e.variant ? { variant: e.variant } : {}), ...(e.label ? { label: e.label } : {}),
  ...(e.anchor ? { anchor: e.anchor, offsetXRatio: e.offsetXRatio, offsetYRatio: e.offsetYRatio } : {}),
  ...(e.slotId ? { slotId: e.slotId } : {}), ...(e.visible === false ? { visible: false } : {}),
});

/** action=layout_policy — 多 source 分屏策略(可只带 perSource 覆盖)。 */
export function execLayoutPolicy(json: Json, c: CaptionsData, ctx: AgentContext): Result {
  if (json.layoutPolicy === null) {
    ctx.commands.updateCaptions({ layoutPolicy: null });
    return { ok: true, layoutPolicy: null, note: 'cleared — 回到默认 auto-stack' };
  }
  const patch: Partial<CaptionsData> = {};
  const mode = str(json.mode);
  if (mode) {
    if (mode === 'single-lane' || mode === 'auto-stack') {
      const cap = num(json.maxVisibleSources);
      patch.layoutPolicy = { mode, ...(cap !== undefined ? { maxVisibleSources: Math.max(1, Math.floor(cap)) } : {}) } as CaptionLayoutPolicy;
    } else if (mode === 'manual-slots') {
      const raw = Array.isArray(json.slots) ? json.slots : null;
      if (!raw?.length) return { error: 'manual-slots 要给槽位表,例 {"mode":"manual-slots","slots":[{"id":"top","anchor":"top-center","offsetYRatio":0.08},{"id":"bottom","anchor":"bottom-center","offsetYRatio":-0.08}]};再用 source_update 把车道 slotId 钉到槽位' };
      const slots: CaptionSlot[] = [];
      for (const sl of raw) {
        const o = (sl ?? {}) as Json;
        const sid = str(o.id);
        const anchor = str(o.anchor);
        if (!sid || !ANCHORS.has(anchor)) return { error: `slot 非法:${JSON.stringify(sl)}(需 id + 3×3 anchor)` };
        slots.push({ id: sid, anchor: anchor as CaptionAnchor, offsetXRatio: num(o.offsetXRatio), offsetYRatio: num(o.offsetYRatio), widthRatio: num(o.widthRatio), heightRatio: num(o.heightRatio) });
      }
      patch.layoutPolicy = { mode, slots };
    } else {
      return { error: `unknown layout_policy mode "${mode}" (single-lane|auto-stack|manual-slots)` };
    }
  }
  if (json.perSource && typeof json.perSource === 'object') {
    const per: Record<string, CaptionPerSource> = { ...(c.perSource ?? {}) };
    for (const [sid, v] of Object.entries(json.perSource as Record<string, Json>)) {
      const ml = num((v ?? {}).maxLines);
      if (ml !== undefined) per[sid] = { ...per[sid], maxLines: Math.max(1, Math.floor(ml)) };
    }
    patch.perSource = per;
  }
  if (!('layoutPolicy' in patch) && !('perSource' in patch)) return { error: 'layout_policy 参数例:{"mode":"auto-stack","maxVisibleSources":2}(上下堆叠)/ {"mode":"single-lane"}(同位只显一条)/ {"mode":"manual-slots","slots":[…]} / {"perSource":{"<sourceId>":{"maxLines":2}}} / {"layoutPolicy":null} 清除' };
  ctx.commands.updateCaptions(patch);
  return { ok: true, layoutPolicy: patch.layoutPolicy ?? c.layoutPolicy ?? { mode: 'auto-stack' }, ...(patch.perSource ? { perSource: patch.perSource } : {}), note: 'perSource.maxLines 按 maxLines×模板每页词数近似(分页按词数)' };
}

/** action=positions — 一次调用摆多个 source(同锚点=同块堆叠)。 */
export function execPositions(json: Json, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  const raw = Array.isArray(json.positions) ? json.positions : null;
  if (!raw?.length) return { error: 'positions 参数例(可直接照抄改数):{"positions":[{"index":0,"anchor":"top-center","offsetYRatio":0.08},{"index":1,"anchor":"bottom-center","offsetYRatio":-0.08}]}——每条 = 选择器(index/sourceId/trackId/variant…)+ anchor(3×3);同 anchor 会堆叠成一块' };
  const entries = ensureEntries(c, s);
  if (!entries.length) return { error: '当前没有字幕 source:先 edit_captions action=enable 开字幕(或 source_set 指定 sources),再来摆位' };
  const placed: Result[] = [];
  for (const p of raw) {
    const o = (p ?? {}) as Json;
    const anchor = str(o.anchor);
    if (!ANCHORS.has(anchor)) return { error: `anchor 非法:"${anchor}"。用 3×3 锚点:top/middle/bottom × left/center/right,如 top-center / bottom-center / middle-left` };
    const m = matchEntries(entries, o, s);
    if ('error' in (m as object)) return m as Result;
    for (const i of m as number[]) {
      entries[i] = { ...entries[i], anchor: anchor as CaptionAnchor, offsetXRatio: num(o.offsetXRatio), offsetYRatio: num(o.offsetYRatio) };
      placed.push(entrySummary(entries[i], i));
    }
  }
  ctx.commands.updateCaptions({ sourceEntries: entries, sources: undefined, sourceMode: 'item' });
  return { ok: true, placed, note: '同 anchor 的多个 source 在该锚点堆叠为一个普通字幕块;像素级 left/top 用 action=layout(整块)' };
}

/** action=source_update — 按选择器改单个/多个 source 的呈现(不动字幕轨/item)。 */
export function execSourceUpdate(json: Json, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  const raw = Array.isArray(json.updates) ? json.updates : (json.update ? [json.update] : null);
  if (!raw?.length) return { error: 'source_update 参数例(可直接照抄改数):{"updates":[{"index":0,"anchor":"bottom-center","offsetYRatio":-0.08},{"trackId":"A2","visible":false},{"index":1,"style":{"sizePx":54,"color":"#fff"}}]}——每条 = 选择器 + 要改的字段(visible/anchor/offsetXRatio/offsetYRatio/slotId/style/preset/variant);sourceId 用 source_list 查' };
  const entries = ensureEntries(c, s);
  if (!entries.length) return { error: '当前没有字幕 source:先 edit_captions action=enable 开字幕(或 source_set 指定 sources)' };
  const updated: Result[] = [];
  const notes: string[] = [];
  for (const u of raw) {
    const o = (u ?? {}) as Json;
    const m = matchEntries(entries, o, s);
    if ('error' in (m as object)) return m as Result;
    for (const i of m as number[]) {
      let e = { ...entries[i] };
      if (typeof o.visible === 'boolean') e.visible = o.visible;
      if (str(o.label)) e.label = str(o.label);
      const pr = num(o.priority);
      if (pr !== undefined) e.priority = pr;
      if (str(o.slotId)) e.slotId = str(o.slotId);
      const anchor = str(o.anchor);
      if (anchor) {
        if (!ANCHORS.has(anchor)) return { error: `anchor 非法:"${anchor}"。用 3×3 锚点,如 top-center / bottom-center / middle-left` };
        e.anchor = anchor as CaptionAnchor;
      }
      for (const k of ['offsetXRatio', 'offsetYRatio', 'widthRatio', 'heightRatio'] as const) {
        const v = num(o[k]);
        if (v !== undefined) e[k] = v;
      }
      // 变体切换:variant 对象或 variantKind+languageCode 简写;要求翻译已存在(源:先 translation_ensure)
      const variantObj = o.variant && typeof o.variant === 'object' ? (o.variant as Json) : undefined;
      const vKind = str(variantObj?.variantKind ?? o.variantKind);
      const vLang = str(variantObj?.languageCode ?? o.languageCode);
      if (vKind || vLang) {
        if (vKind && vKind !== 'translation') return { error: `variantKind "${vKind}" 不支持(仅 translation)` };
        if (!vLang) return { error: 'variant 切换要给翻译目标语言,例 {"variant":{"variantKind":"translation","languageCode":"en"}} 或简写 {"languageCode":"en"}' };
        const item = s.items.find((it) => it.id === e.itemId);
        const v = item ? findVariantByLang(item.variants ?? [], vLang, 'translation') : undefined;
        if (!v) return { error: `item ${e.itemId.slice(0, 8)} 上没有 "${vLang}" 翻译变体 — 先 manage_transcript translation_ensure` };
        e.variant = { variantKind: 'translation', languageCode: vLang };
      }
      if (o.variant === null) e = { ...e, variant: undefined };
      // per-source 样式:preset(模板 id → 整套样式)与/或 style 显式字段
      const presetId = str(o.preset) || str(o.templatePreset);
      if (presetId) {
        const tpl = CAPTION_STYLE_BY_ID[presetId as CaptionTemplate];
        if (!tpl) return { error: `unknown preset "${presetId}"` };
        const { id: _i, label: _l, labelZh: _z, hint: _h, ...styleOnly } = tpl;
        e.style = { ...styleOnly };
      }
      if (o.style && typeof o.style === 'object') {
        const mapped = mapCaptionStyle(o.style as Json, s.height);
        e.style = { ...e.style, ...mapped.styleOverride };
        if (mapped.ignored.length) notes.push(`style 忽略字段:${mapped.ignored.join(',')}`);
      }
      entries[i] = e;
      updated.push(entrySummary(e, i));
    }
  }
  ctx.commands.updateCaptions({ sourceEntries: entries, sources: undefined, sourceMode: 'item' });
  return { ok: true, updated, ...(notes.length ? { notes } : {}) };
}
