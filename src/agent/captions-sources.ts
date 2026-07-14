import type { AgentContext } from './context';
import type { CaptionsData } from '../captions/types';
import { resolveCaptionWords } from '../captions/resolve';
import { buildTranslation } from '../captions/translate';
import { findVariantByLang } from '../transcript/variants';
import { resolveTrackId, trackAlias, type TimelineItem, type TimelineState } from '../editor/types';

// edit_captions multi-source + language cluster (source actions: source_list /
// source_set / source_add / source_remove / language_mode / bilingual). The clone
// captions overlay merges several items' transcripts into ONE time-ordered stream
// (CaptionsData.sources / sourceMode) and can show a translation as the MAIN line
// (captionVariantId) or as a bilingual 2nd line (translation/bilingual). We map the
// source's source-scope vocabulary onto exactly those fields, honestly noting the
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

/** source_list — report the current scope + what's available to caption. */
export function sourceList(c: CaptionsData, s: TimelineState): Result {
  return {
    ok: true,
    sourceMode: c.sourceMode ?? 'item',
    sources: c.sources ?? null,
    sourceItemId: c.sourceItemId ?? null,
    availableTracks: [...new Set(transcribedItems(s).map((it) => trackAlias(s, it.track)))],
    availableItems: transcribedItems(s).map((it) => ({ itemId: it.id, track: trackAlias(s, it.track), name: it.name })),
    note: 'This build merges sources into ONE stacked caption stream; per-source positions/priority/slots are not modeled (use action=positions → unsupported).',
  };
}

/** source_set — replace the whole scope. {mode:'timeline'} | {sources:[...]} | {sourceScope:null}. */
export function sourceSet(json: Record<string, unknown>, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  if (json.sourceScope === null || json.mode === 'clear') {
    ctx.commands.updateCaptions({ sources: undefined, sourceMode: 'item' });
    return { ok: true, sourceMode: 'item', sources: null };
  }
  if (str(json.mode) === 'timeline') {
    ctx.commands.updateCaptions({ sourceMode: 'timeline' });
    return { ok: true, sourceMode: 'timeline', wordCount: resolveCaptionWords({ ...c, sourceMode: 'timeline' }, s.items, s.fps).length };
  }
  const rawSources = json.sources;
  if (!Array.isArray(rawSources) || rawSources.length === 0) return { error: 'source_set needs {mode:"timeline"}, a non-empty {sources:[...]}, or {sourceScope:null}' };
  const ids: string[] = [];
  const bad: string[] = [];
  for (const sel of rawSources) {
    const id = sel && typeof sel === 'object' ? selectorToItemId(sel as Record<string, unknown>, s) : null;
    if (id) ids.push(id); else bad.push(JSON.stringify(sel));
  }
  if (bad.length) return { error: `unresolved/untranscribed source(s): ${bad.join(', ')}` };
  const patch: Partial<CaptionsData> = { sources: ids, sourceMode: 'item' };
  ctx.commands.updateCaptions(patch);
  return { ok: true, sourceMode: 'item', sources: ids, wordCount: resolveCaptionWords({ ...c, ...patch }, s.items, s.fps).length };
}

/** source_add — append one source to the current scope. */
export function sourceAdd(json: Record<string, unknown>, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  const sel = json.source && typeof json.source === 'object' ? (json.source as Record<string, unknown>) : json;
  const id = selectorToItemId(sel, s);
  if (!id) return { error: 'source_add needs {source:{trackId|itemId|assetId}} referencing a transcribed item' };
  const next = [...(c.sources ?? (c.sourceItemId ? [c.sourceItemId] : [])), id].filter((v, i, a) => a.indexOf(v) === i);
  ctx.commands.updateCaptions({ sources: next, sourceMode: 'item' });
  return { ok: true, sources: next, wordCount: resolveCaptionWords({ ...c, sources: next, sourceMode: 'item' }, s.items, s.fps).length };
}

/** source_remove — drop one source by {index|itemId|trackId|assetId}. */
export function sourceRemove(json: Record<string, unknown>, c: CaptionsData, ctx: AgentContext, s: TimelineState): Result {
  const cur = c.sources ?? (c.sourceItemId ? [c.sourceItemId] : []);
  if (!cur.length) return { error: 'no multi-source scope to remove from' };
  let next: string[];
  const idx = typeof json.index === 'number' ? json.index : undefined;
  if (idx !== undefined) {
    if (idx < 0 || idx >= cur.length) return { error: `index ${idx} out of range (0..${cur.length - 1})` };
    next = cur.filter((_, i) => i !== idx);
  } else {
    const target = selectorToItemId(json, s);
    if (!target) return { error: 'source_remove needs {index} or a {itemId|trackId|assetId} selector' };
    next = cur.filter((id) => id !== target);
    if (next.length === cur.length) return { error: `source ${target} not in the current scope` };
  }
  ctx.commands.updateCaptions({ sources: next.length ? next : undefined, sourceMode: 'item' });
  return { ok: true, sources: next.length ? next : null };
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
    if (!v) return { error: `no "${lang}" transcript variant on the caption source; run manage_transcript translate first` };
    ctx.commands.updateCaptions({ captionVariantId: v.id, bilingual: false, translation: undefined });
    return { ok: true, mode: 'translation', languageCode: v.lang, note: 'main caption line now shows the translation variant (source timing preserved).' };
  }
  if (mode === 'bilingual') return bilingual(json, c, ctx, s, lang);
  return { error: `unknown language_mode "${mode}" (expected original|translation|bilingual)` };
}

/** bilingual — original + a translated 2nd line (source action=bilingual / language_mode bilingual). */
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
