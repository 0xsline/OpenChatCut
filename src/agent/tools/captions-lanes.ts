import type { AgentContext } from '../context';
import type { CaptionAnchor, CaptionLayoutPolicy, CaptionPerSource, CaptionSlot, CaptionsData, CaptionSourceEntry } from '../../captions/types';
import { mapCaptionStyle } from '../../captions/styleMap';
import { CAPTION_STYLE_BY_ID } from '../../captions/styles';
import type { CaptionTemplate } from '../../captions/types';
import { findVariantByLang } from '../../transcript/variants';
import { resolveTrackId, type TimelineState } from '../../editor/types';
import { moveCaptionSourceEntry, normalizeCaptionSourceEntries } from '../../captions/sourceOrder';

// edit_captions Multi-lane tool set:
// - positions puts multiple sources into place in one call (same anchor point = stacking in the same block)
// - layout_policy single-lane / auto-stack / manual-slots + perSource overrides
// - source_update changes the visibility/anchor/slot/style/variation of a single source according to the selector
// Data falls into CaptionsData.sourceEntries / layoutPolicy / perSource(captions/types.ts),
// Rendering is consumed by the captions/lanes.ts engine.

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

/** now scope promoted to sourceEntries(If you already have one, copy it;old sources[]/sourceItemId/timeline One-time upgrade)。 */
export function ensureEntries(c: CaptionsData, s: TimelineState): CaptionSourceEntry[] {
  if (c.sourceEntries?.length) return normalizeCaptionSourceEntries(c.sourceEntries);
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

/** selector → hit entry subscript(selector family:index/id/sourceId/itemId/trackId/assetId/label/variant/slotId)。 */
export function matchEntries(entries: CaptionSourceEntry[], sel: Json, s: TimelineState): number[] | { error: string } {
  const idx = num(sel.index);
  if (idx !== undefined) {
    if (idx < 0 || idx >= entries.length) return { error: `index ${idx} out of range (0..${entries.length - 1})` };
    return [idx];
  }
  if (str(sel.speakerId)) return { error: 'speakerId selector Not supported:None per-speaker driveway,Please click the track/press item Choose' };
  const id = str(sel.sourceId) || str(sel.id);
  if (id) {
    const hits = entries.flatMap((e, i) => (e.id === id ? [i] : []));
    return hits.length ? hits : { error: `no source with id "${id}" (source_list check sourceId)` };
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
  return { error: 'Missing selector:Bring each item index / sourceId / trackId / itemId / label / variant One of the positioning lanes,Example {"index":0} or {"trackId":"A2"} or {"variant":{"languageCode":"en"}};sourceId use source_list check' };
}

const entrySummary = (e: CaptionSourceEntry, i: number) => ({
  index: i, trackOrder: e.trackOrder ?? i, sourceId: e.id, itemId: e.itemId,
  ...(e.variant ? { variant: e.variant } : {}), ...(e.label ? { label: e.label } : {}),
  ...(e.anchor ? { anchor: e.anchor, offsetXRatio: e.offsetXRatio, offsetYRatio: e.offsetYRatio } : {}),
  ...(e.slotId ? { slotId: e.slotId } : {}), ...(e.visible === false ? { visible: false } : {}),
});

/** action=layout_policy — Many source split screen strategy(Can only bring perSource Cover)。 */
export function execLayoutPolicy(json: Json, c: CaptionsData, ctx: AgentContext): Result {
  if (json.layoutPolicy === null) {
    ctx.commands.updateCaptions({ layoutPolicy: null });
    return { ok: true, layoutPolicy: null, note: 'cleared — Return to default auto-stack' };
  }
  const patch: Partial<CaptionsData> = {};
  const mode = str(json.mode);
  if (mode) {
    if (mode === 'single-lane' || mode === 'auto-stack') {
      const cap = num(json.maxVisibleSources);
      patch.layoutPolicy = { mode, ...(cap !== undefined ? { maxVisibleSources: Math.max(1, Math.floor(cap)) } : {}) } as CaptionLayoutPolicy;
    } else if (mode === 'manual-slots') {
      const raw = Array.isArray(json.slots) ? json.slots : null;
      if (!raw?.length) return { error: 'manual-slots Need to give slot table,Example {"mode":"manual-slots","slots":[{"id":"top","anchor":"top-center","offsetYRatio":0.08},{"id":"bottom","anchor":"bottom-center","offsetYRatio":-0.08}]};reuse source_update driveway slotId nail into slot' };
      const slots: CaptionSlot[] = [];
      for (const sl of raw) {
        const o = (sl ?? {}) as Json;
        const sid = str(o.id);
        const anchor = str(o.anchor);
        if (!sid || !ANCHORS.has(anchor)) return { error: `slot illegal:${JSON.stringify(sl)}(Need id + 3×3 anchor)` };
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
  if (!('layoutPolicy' in patch) && !('perSource' in patch)) return { error: 'layout_policy Parameter example:{"mode":"auto-stack","maxVisibleSources":2}(stacked on top of each other)/ {"mode":"single-lane"}(Only one item is displayed for the same position)/ {"mode":"manual-slots","slots":[…]} / {"perSource":{"<sourceId>":{"maxLines":2}}} / {"layoutPolicy":null} Clear' };
  ctx.commands.updateCaptions(patch);
  return { ok: true, layoutPolicy: patch.layoutPolicy ?? c.layoutPolicy ?? { mode: 'auto-stack' }, ...(patch.perSource ? { perSource: patch.perSource } : {}), note: 'perSource.maxLines press maxLines×Approximate number of words per page of template(Pagination by word count)' };
}

/** action=positions — Multiple calls at one time source(Same anchor point=Same block stacking)。 */
export function execPositions(json: Json, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  const raw = Array.isArray(json.positions) ? json.positions : null;
  if (!raw?.length) return { error: 'positions Parameter example(Can be directly copied and modified):{"positions":[{"index":0,"anchor":"top-center","offsetYRatio":0.08},{"index":1,"anchor":"bottom-center","offsetYRatio":-0.08}]}——Every item = selector(index/sourceId/trackId/variant…)+ anchor(3×3);Same anchor will be stacked together' };
  const entries = ensureEntries(c, s);
  if (!entries.length) return { error: 'There are currently no subtitles source:first edit_captions action=enable Turn on subtitles(or source_set Specify sources),Let’s set up again' };
  const placed: Result[] = [];
  for (const p of raw) {
    const o = (p ?? {}) as Json;
    const anchor = str(o.anchor);
    if (!ANCHORS.has(anchor)) return { error: `anchor illegal:"${anchor}". use 3×3 anchor point:top/middle/bottom × left/center/right,Such as top-center / bottom-center / middle-left` };
    const m = matchEntries(entries, o, s);
    if ('error' in (m as object)) return m as Result;
    for (const i of m as number[]) {
      entries[i] = { ...entries[i], anchor: anchor as CaptionAnchor, offsetXRatio: num(o.offsetXRatio), offsetYRatio: num(o.offsetYRatio) };
      placed.push(entrySummary(entries[i], i));
    }
  }
  ctx.commands.updateCaptions({ sourceEntries: entries, sources: undefined, sourceMode: 'item' });
  return { ok: true, placed, note: 'Same anchor of multiple source Stack as a normal subtitle block at this anchor point;Pixel level left/top use action=layout(whole piece)' };
}

/** action=source_update — Press the selector to change a single/multiple source presentation(No subtitle track/item)。 */
export function execSourceUpdate(json: Json, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  const raw = Array.isArray(json.updates) ? json.updates : (json.update ? [json.update] : null);
  if (!raw?.length) return { error: 'source_update Parameter example(Can be directly copied and modified):{"updates":[{"index":0,"anchor":"bottom-center","offsetYRatio":-0.08},{"trackId":"A2","visible":false},{"index":1,"style":{"sizePx":54,"color":"#fff"}}]}——Every item = selector + Field to be changed(visible/anchor/offsetXRatio/offsetYRatio/slotId/style/preset/variant);sourceId use source_list check' };
  let entries = ensureEntries(c, s);
  if (!entries.length) return { error: 'There are currently no subtitles source:first edit_captions action=enable Turn on subtitles(or source_set Specify sources)' };
  const updated: Result[] = [];
  const notes: string[] = [];
  for (const u of raw) {
    const o = (u ?? {}) as Json;
    const m = matchEntries(entries, o, s);
    if ('error' in (m as object)) return m as Result;
    const matchedIds = (m as number[]).map((i) => entries[i]?.id).filter((id): id is string => !!id);
    const requestedOrder = num(o.trackOrder);
    for (const sourceId of matchedIds) {
      const i = entries.findIndex((entry) => entry.id === sourceId);
      if (i < 0) continue;
      let e = { ...entries[i] };
      if (typeof o.visible === 'boolean') e.visible = o.visible;
      if (str(o.label)) e.label = str(o.label);
      const pr = num(o.priority);
      if (pr !== undefined) e.priority = pr;
      if (str(o.slotId)) e.slotId = str(o.slotId);
      const anchor = str(o.anchor);
      if (anchor) {
        if (!ANCHORS.has(anchor)) return { error: `anchor illegal:"${anchor}". use 3×3 anchor point,Such as top-center / bottom-center / middle-left` };
        e.anchor = anchor as CaptionAnchor;
      }
      for (const k of ['offsetXRatio', 'offsetYRatio', 'widthRatio', 'heightRatio'] as const) {
        const v = num(o[k]);
        if (v !== undefined) e[k] = v;
      }
      // Variant switching: variant object or variantKind+languageCode abbreviation; requires translation to already exist (source: first translation_ensure)
      const variantObj = o.variant && typeof o.variant === 'object' ? (o.variant as Json) : undefined;
      const vKind = str(variantObj?.variantKind ?? o.variantKind);
      const vLang = str(variantObj?.languageCode ?? o.languageCode);
      if (vKind || vLang) {
        if (vKind && vKind !== 'translation') return { error: `variantKind "${vKind}" Not supported(only translation)` };
        if (!vLang) return { error: 'variant Switch the target language for translation,Example {"variant":{"variantKind":"translation","languageCode":"en"}} or abbreviation {"languageCode":"en"}' };
        const item = s.items.find((it) => it.id === e.itemId);
        const v = item ? findVariantByLang(item.variants ?? [], vLang, 'translation') : undefined;
        if (!v) return { error: `item ${e.itemId.slice(0, 8)} There is no "${vLang}" Translation variants — first manage_transcript translation_ensure` };
        e.variant = { variantKind: 'translation', languageCode: vLang };
      }
      if (o.variant === null) e = { ...e, variant: undefined };
      // per-source style: preset (template id → complete set of styles) and/or style explicit field
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
        if (mapped.ignored.length) notes.push(`style Ignore fields:${mapped.ignored.join(',')}`);
      }
      entries[i] = e;
      updated.push(entrySummary(e, i));
    }
    if (requestedOrder !== undefined) {
      matchedIds.forEach((sourceId, offset) => {
        entries = moveCaptionSourceEntry(entries, sourceId, requestedOrder + offset);
      });
    }
  }
  entries = normalizeCaptionSourceEntries(entries);
  ctx.commands.updateCaptions({ sourceEntries: entries, sources: undefined, sourceMode: 'item' });
  return { ok: true, updated: entries.map(entrySummary), ...(notes.length ? { notes } : {}) };
}
