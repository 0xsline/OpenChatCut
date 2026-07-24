import type { TimelineItem } from '../editor/types';
import { effectivePreset } from './renderStyles';
import { resolveCaptionWordIndices, resolveCaptionWords } from './resolve';
import type { CaptionsData, CaptionWordOverride } from './types';
import { joinCaptionWords, paginate } from './types';

export interface CueRow {
  start: number;
  end: number;
  text: string;
  /** The visible words in this sentence are in wordOverrides keys in index space */
  srcIdxs: number[];
}

export function fmtCueMs(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${(seconds - minutes * 60).toFixed(1).padStart(4, '0')}`;
}

/** render layer SingleStreamCaptions paging calculation,but retain the value of each visible word override key. */
export function buildCues(captions: CaptionsData, items: TimelineItem[], fps: number): CueRow[] {
  const words = resolveCaptionWords(captions, items, fps);
  const indices = resolveCaptionWordIndices(captions, items, fps);
  const overrides = captions.wordOverrides ?? {};
  const visible: { text: string; src: number }[] = [];
  const visibleWords: typeof words = [];
  const breakBefore = new Set<number>();
  for (let index = 0; index < words.length; index += 1) {
    const override = overrides[indices[index] ?? -1];
    if (override?.hidden) continue;
    if (override?.forceBreak && visible.length > 0) breakBefore.add(visible.length);
    const word = override?.text ? { ...words[index]!, text: override.text } : words[index]!;
    visible.push({ text: word.text, src: indices[index] ?? -1 });
    visibleWords.push(word);
  }
  const preset = effectivePreset(captions);
  const pages = paginate(visibleWords, captions.pacing, preset.wordsPerPage, breakBefore);
  const rows: CueRow[] = [];
  let cursor = 0;
  for (const page of pages) {
    const slice = visible.slice(cursor, cursor + page.words.length);
    rows.push({
      start: page.start,
      end: page.end,
      text: joinCaptionWords(page.words),
      srcIdxs: slice.map((value) => value.src).filter((source) => source >= 0),
    });
    cursor += page.words.length;
  }
  return rows;
}

/** Number one k The text changes of the sentence are translated into wordOverrides Patch. */
export function cueTextPatch(
  captions: CaptionsData,
  rows: CueRow[],
  index: number,
  text: string,
): Partial<CaptionsData> | null {
  const cue = rows[index];
  if (!cue || cue.srcIdxs.length === 0) return null;
  const next: Record<number, CaptionWordOverride> = { ...(captions.wordOverrides ?? {}) };
  const put = (source: number, patch: CaptionWordOverride) => {
    next[source] = { ...next[source], ...patch };
  };
  const trimmed = text.trim();
  if (!trimmed) {
    for (const source of cue.srcIdxs) put(source, { hidden: true });
  } else {
    const [first, ...rest] = cue.srcIdxs;
    put(first!, { text: trimmed, hidden: false, forceBreak: true });
    for (const source of rest) put(source, { hidden: true });
    const nextFirst = rows[index + 1]?.srcIdxs[0];
    if (nextFirst !== undefined) put(nextFirst, { forceBreak: true });
  }
  return { wordOverrides: next };
}
