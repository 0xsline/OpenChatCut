import type { AgentContext } from '../context';
import type { CaptionsData, CaptionSourceEntry } from '../../captions/types';
import { resolveCaptionWords } from '../../captions/resolve';
import { ensureEntries, matchEntries } from './captions-lanes';
import { buildTranslation } from '../../captions/translate';
import { findVariantByLang } from '../../transcript/variants';
import { resolveTrackId, trackAlias, type TimelineItem, type TimelineState } from '../../editor/types';

// edit_captions multi-source + language cluster (actions: source_list /
// source_set / source_add / source_remove / language_mode / bilingual). The
// captions overlay merges several items' transcripts into ONE time-ordered stream
// (CaptionsData.sources / sourceMode) and can show a translation as the MAIN line
// (captionVariantId) or as a bilingual 2nd line (translation/bilingual). The
// source_* action vocabulary maps onto exactly those fields, honestly noting the
// parts (per-source positions/priority/slots) this single-stream model can't hold.

type Result = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Resolve a source selector ({trackId|itemId|assetId}) to a transcribed item id. */
function selectorToItemId(sel: Record<string, unknown>, s: TimelineState): string | null {
  const itemId = str(sel.itemId) || str(sel.id);
  if (itemId) { const it = s.items.find((x) => x.id === itemId || x.id.startsWith(itemId)); return it?.id ?? null; }
  const assetId = str(sel.assetId);
  if (assetId) { const it = s.items.find((x) => x.src === assetId || x.templateId === assetId); return it?.id ?? null; }
  const track = str(sel.trackId) || str(sel.track);
  if (track) return firstTranscribedOnTrack(s, track)?.id ?? null;
  return null;
}

/** First item on a track (alias V1/A1 or id) that carries a transcript. */
export function firstTranscribedOnTrack(s: TimelineState, trackAliasOrId: string): TimelineItem | null {
  const tid = resolveTrackId(s, trackAliasOrId) ?? trackAliasOrId;
  return s.items.find((it) => it.track === tid && (it.transcript?.length ?? 0) > 0) ?? null;
}

const transcribedItems = (s: TimelineState) => s.items.filter((it) => (it.transcript?.length ?? 0) > 0);

/** One selector → a rich CaptionSourceEntry (variant/label/priority/slotId ride along). */
function selectorToEntry(sel: Record<string, unknown>, s: TimelineState): CaptionSourceEntry | { error: string } {
  const itemId = selectorToItemId(sel, s);
  if (!itemId) return { error: `unresolved/untranscribed source: ${JSON.stringify(sel)}` };
  const entry: CaptionSourceEntry = { id: newLaneId(), itemId };
  const variantObj = sel.variant && typeof sel.variant === 'object' ? (sel.variant as Record<string, unknown>) : undefined;
  const vKind = str(variantObj?.variantKind ?? sel.variantKind);
  const vLang = str(variantObj?.languageCode ?? sel.languageCode);
  if (vKind || vLang) {
    if (vKind && vKind !== 'translation') return { error: `variantKind "${vKind}" 不支持(仅 translation)` };
    if (!vLang) return { error: 'variant 需要 languageCode(翻译目标语言)' };
    const item = s.items.find((it) => it.id === itemId);
    if (!item?.variants || !findVariantByLang(item.variants, vLang, 'translation')) {
      return { error: `item ${itemId.slice(0, 8)} 上没有 "${vLang}" 翻译变体 — 先 manage_transcript translation_ensure` };
    }
    entry.variant = { variantKind: 'translation', languageCode: vLang };
  }
  if (str(sel.label)) entry.label = str(sel.label);
  if (typeof sel.priority === 'number' && Number.isFinite(sel.priority)) entry.priority = sel.priority;
  if (str(sel.slotId)) entry.slotId = str(sel.slotId);
  return entry;
}

let laneSeq = 0;
const newLaneId = (): string => `src_${(++laneSeq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const entryRow = (e: CaptionSourceEntry, i: number, s: TimelineState) => {
  const it = s.items.find((x) => x.id === e.itemId);
  return {
    index: i, sourceId: e.id, itemId: e.itemId,
    track: it ? trackAlias(s, it.track) : null,
    ...(e.variant ? { variant: e.variant } : {}), ...(e.label ? { label: e.label } : {}),
    ...(e.anchor ? { anchor: e.anchor } : {}), ...(e.slotId ? { slotId: e.slotId } : {}),
    ...(e.visible === false ? { visible: false } : {}),
  };
};

/** source_list — current scope + layout policy + visual order + what's available. */
export function sourceList(c: CaptionsData, s: TimelineState): Result {
  return {
    ok: true,
    sourceMode: c.sourceEntries?.length ? 'sources' : (c.sourceMode ?? 'item'),
    sources: c.sourceEntries?.map((e, i) => entryRow(e, i, s)) ?? c.sources ?? null,
    sourceItemId: c.sourceItemId ?? null,
    layoutPolicy: c.layoutPolicy ?? { mode: 'auto-stack' },
    ...(c.perSource && Object.keys(c.perSource).length ? { perSource: c.perSource } : {}),
    availableTracks: [...new Set(transcribedItems(s).map((it) => trackAlias(s, it.track)))],
    availableItems: transcribedItems(s).map((it) => ({
      itemId: it.id, track: trackAlias(s, it.track), name: it.name,
      translations: (it.variants ?? []).filter((v) => v.kind === 'translation').map((v) => v.lang),
    })),
    note: 'auto-stack 里 sources 自上而下按列表序渲染(第一个在最上);per-source 摆位/样式用 positions / source_update。',
  };
}

/** source_set — replace the whole scope. {mode:'timeline'} | {sources:[...]} | {sourceScope:null}. */
export function sourceSet(json: Record<string, unknown>, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  if (json.sourceScope === null || json.mode === 'clear') {
    ctx.commands.updateCaptions({ sources: undefined, sourceEntries: undefined, layoutPolicy: undefined, perSource: undefined, sourceMode: 'item' });
    return { ok: true, sourceMode: 'item', sources: null, note: 'cleared — 回到单源 sourceItemId' };
  }
  if (str(json.mode) === 'timeline') {
    ctx.commands.updateCaptions({ sourceMode: 'timeline', sources: undefined, sourceEntries: undefined });
    return { ok: true, sourceMode: 'timeline', wordCount: resolveCaptionWords({ ...c, sourceMode: 'timeline', sources: undefined, sourceEntries: undefined }, s.items, s.fps).length };
  }
  const rawSources = json.sources;
  if (!Array.isArray(rawSources) || rawSources.length === 0) return { error: 'source_set needs {mode:"timeline"}, a non-empty {sources:[...]}, or {sourceScope:null}' };
  const entries: CaptionSourceEntry[] = [];
  for (const sel of rawSources) {
    const e = sel && typeof sel === 'object' ? selectorToEntry(sel as Record<string, unknown>, s) : { error: `bad source: ${JSON.stringify(sel)}` };
    if ('error' in e) return e;
    entries.push(e);
  }
  const patch: Partial<CaptionsData> = { sourceEntries: entries, sources: undefined, sourceMode: 'item' };
  ctx.commands.updateCaptions(patch);
  return {
    ok: true, sources: entries.map((e, i) => entryRow(e, i, s)),
    wordCount: resolveCaptionWords({ ...c, ...patch }, s.items, s.fps).length,
    note: 'auto-stack:列表第一个渲染在最上。',
  };
}

/** source_add — append one source ({source:{...}}) to the existing scope. */
export function sourceAdd(json: Record<string, unknown>, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  const sel = json.source && typeof json.source === 'object' ? (json.source as Record<string, unknown>) : json;
  const e = selectorToEntry(sel, s);
  if ('error' in e) return { error: `source_add: ${e.error}` };
  const cur = ensureEntries(c, s);
  // 同 item+variant 已在 scope → 幂等不重复
  if (cur.some((x) => x.itemId === e.itemId && (x.variant?.languageCode ?? '') === (e.variant?.languageCode ?? ''))) {
    return { ok: true, sources: cur.map((x, i) => entryRow(x, i, s)), note: 'already in scope (idempotent)' };
  }
  const next = [...cur, e];
  ctx.commands.updateCaptions({ sourceEntries: next, sources: undefined, sourceMode: 'item' });
  return { ok: true, sources: next.map((x, i) => entryRow(x, i, s)) };
}

/** source_remove — drop one source by top-level selector (index/trackId/itemId/…). */
export function sourceRemove(json: Record<string, unknown>, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  const cur = ensureEntries(c, s);
  if (!cur.length) return { error: 'no multi-source scope to remove from' };
  const m = matchEntries(cur, json, s);
  if ('error' in (m as object)) return m as Result;
  const drop = new Set(m as number[]);
  const next = cur.filter((_, i) => !drop.has(i));
  // 删到最后一个时回落到单源模式。
  ctx.commands.updateCaptions({ sourceEntries: next.length ? next : undefined, sources: undefined, sourceMode: 'item' });
  return { ok: true, sources: next.length ? next.map((x, i) => entryRow(x, i, s)) : null };
}

/** language_mode — canonical caption language switch (original / translation / bilingual). */
export async function languageMode(json: Record<string, unknown>, c: CaptionsData, ctx: AgentContext, s: TimelineState): Promise<Result> {
  const mode = str(json.mode) || 'original';
  const lang = str(json.languageCode) || str(json.lang);
  if (mode === 'original') {
    ctx.commands.updateCaptions({ captionVariantId: undefined, bilingual: false, translation: undefined, translationLang: undefined });
    return { ok: true, mode: 'original' };
  }
  if (mode === 'translation') {
    if (!lang) return { error: 'translation mode needs languageCode (the target language)' };
    const it = c.sourceItemId ? s.items.find((x) => x.id === c.sourceItemId) : firstTranscribedOnTrack(s, 'A1');
    const v = it?.variants ? findVariantByLang(it.variants, lang, 'translation') : undefined;
    if (!v) return { error: `no "${lang}" transcript variant on the caption source; run manage_transcript translation_ensure first` };
    ctx.commands.updateCaptions({ captionVariantId: v.id, bilingual: false, translation: undefined });
    return { ok: true, mode: 'translation', languageCode: v.lang, note: 'main caption line now shows the translation variant (source timing preserved).' };
  }
  if (mode === 'bilingual') return bilingual(json, c, ctx, s, lang);
  return { error: `unknown language_mode "${mode}" (expected original|translation|bilingual)` };
}

/** bilingual — original + a translated 2nd line (action=bilingual / language_mode bilingual). */
export async function bilingual(json: Record<string, unknown>, c: CaptionsData, ctx: AgentContext, s: TimelineState, langArg?: string): Promise<Result> {
  const lang = langArg ?? (str(json.languageCode) || str(json.lang));
  if (!lang) return { error: 'bilingual needs languageCode (the language to translate INTO)' };
  try {
    const cues = await buildTranslation(c, s.items, s.fps, lang);
    ctx.commands.updateCaptions({ translation: cues, translationLang: lang, bilingual: true });
    const primary = str(json.primary) || 'original';
    return {
      ok: true, mode: 'bilingual', languageCode: lang, lines: cues.length,
      ...(primary === 'translation' ? { note: 'this build always stacks the original on top; primary:"translation" ordering not modeled.' } : {}),
    };
  } catch (e) {
    return { error: `translation failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
