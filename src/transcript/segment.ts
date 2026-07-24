import type { TranscriptWord } from './types';

// A word plus its global index in the flat transcript (so a click in any view
// maps back to the one word to delete).
export interface IndexedWord extends TranscriptWord {
  gi: number;
}

export interface WordGroup {
  speaker: string;
  words: IndexedWord[];
}

// 'A' → 'Speaker 1', 'B' → 'Speaker 2', … (AssemblyAI diarization codes).
export function speakerLabel(code: string | null | undefined): string {
  if (!code) return 'speaker';
  const n = code.charCodeAt(0) - 65;
  return Number.isFinite(n) && n >= 0 ? `speaker ${n + 1}` : `speaker ${code}`;
}

/** Whether a string is mostly CJK (no space between word chips). */
export function isCjkText(s: string): boolean {
  const letters = s.replace(/\s/g, '');
  if (!letters) return false;
  let cjk = 0;
  for (const ch of letters) {
    const c = ch.codePointAt(0) ?? 0;
    if (
      (c >= 0x4e00 && c <= 0x9fff)
      || (c >= 0x3400 && c <= 0x4dbf)
      || (c >= 0x3040 && c <= 0x30ff)
      || (c >= 0xac00 && c <= 0xd7af)
    ) cjk += 1;
  }
  return cjk / letters.length >= 0.4;
}

const index = (words: TranscriptWord[]): IndexedWord[] => words.map((w, gi) => ({ ...w, gi }));

// Paragraph view: merge CONSECUTIVE same-speaker words into reading paragraphs.
export function toParagraphs(words: TranscriptWord[]): WordGroup[] {
  const out: WordGroup[] = [];
  for (const w of index(words)) {
    const sp = w.speaker ?? '';
    const last = out[out.length - 1];
    if (last && last.speaker === sp) last.words.push(w);
    else out.push({ speaker: sp, words: [w] });
  }
  return out;
}

const SENTENCE_END = /[.!?。！?…]$/;

// Fragment view: split into sentence-level segments (the granular editing grain).
export function toSegments(words: TranscriptWord[]): WordGroup[] {
  const out: WordGroup[] = [];
  let cur: IndexedWord[] = [];
  const flush = () => { if (cur.length) out.push({ speaker: cur[0].speaker ?? '', words: cur }); cur = []; };
  for (const w of index(words)) {
    cur.push(w);
    if (SENTENCE_END.test(w.text)) flush();
  }
  flush();
  return out;
}

// Pause analysis: count gaps between consecutive words longer than compressToMs
// and how much total time compressing each down to compressToMs would save.
export function analyzeSilences(words: TranscriptWord[], compressToMs: number): { count: number; savedMs: number } {
  let count = 0;
  let savedMs = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > compressToMs) { count++; savedMs += gap - compressToMs; }
  }
  return { count, savedMs };
}

/** Gap clock: `0:01` for approximately one second (m:ss). */
export function formatGapClock(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export type ScriptRow =
  | { kind: 'speech'; speaker: string; words: IndexedWord[] }
  | {
      kind: 'gap';
      /** word index AFTER the gap (for gapCapsMs key) */
      afterWordGi: number;
      /** original recorded gap ms */
      gapMs: number;
      /** gap after per-gap / global caps */
      appliedMs: number;
      /** true when a per-gap cap of 0 (or near) has deleted this breath */
      removed: boolean;
    };

function effectiveGapMs(
  rawMs: number,
  afterWordGi: number,
  gapCapsMs?: Record<string, number>,
  globalMaxMs?: number,
): number {
  const key = String(afterWordGi);
  if (gapCapsMs && Object.prototype.hasOwnProperty.call(gapCapsMs, key)) {
    return Math.min(rawMs, Math.max(0, gapCapsMs[key]!));
  }
  if (globalMaxMs != null) return Math.min(rawMs, globalMaxMs);
  return rawMs;
}

/**
 * Build script rows: speaker speech blocks + Gap rows between pauses.
 * Gaps use source word timings; `gapCapsMs` / global silence max shrink appliedMs.
 */
export function buildScriptRows(
  words: TranscriptWord[],
  deleted: Set<number>,
  opts: {
    gapCapsMs?: Record<string, number>;
    /** global clean_script max gap (frames) */
    silenceFrames?: number;
    fps: number;
    /** min raw gap to surface a Gap row (default 250ms) */
    minDisplayMs?: number;
    /** playback / display order of source word indices (speech-block drag) */
    playOrder?: number[];
  },
): ScriptRow[] {
  const all = index(words);
  const kept = (
    opts.playOrder?.length
      ? opts.playOrder.map((i) => all[i]).filter((w): w is IndexedWord => !!w && !deleted.has(w.gi))
      : all.filter((w) => !deleted.has(w.gi))
  );
  if (!kept.length) return [];
  const minD = opts.minDisplayMs ?? 250;
  const globalMaxMs = opts.silenceFrames != null
    ? (opts.silenceFrames / Math.max(1, opts.fps)) * 1000
    : undefined;

  const rows: ScriptRow[] = [];
  let speech: IndexedWord[] = [kept[0]!];
  let speaker = kept[0]!.speaker ?? '';

  const flushSpeech = () => {
    if (speech.length) rows.push({ kind: 'speech', speaker, words: speech });
    speech = [];
  };

  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1]!;
    const cur = kept[i]!;
    const rawGap = cur.start - prev.end; // may be negative after reorder jump
    const speakerChange = (cur.speaker ?? '') !== speaker;

    // Reorder jump (play later block first): break speech, no natural Gap row
    if (rawGap < 0) {
      flushSpeech();
      speaker = cur.speaker ?? '';
      speech = [cur];
      continue;
    }

    const applied = effectiveGapMs(rawGap, cur.gi, opts.gapCapsMs, globalMaxMs);
    const key = String(cur.gi);
    const removed = !!(opts.gapCapsMs && Object.prototype.hasOwnProperty.call(opts.gapCapsMs, key) && (opts.gapCapsMs[key] ?? 0) <= 30);
    const showGap = rawGap >= minD || (speakerChange && rawGap >= 120) || removed;

    if (showGap) {
      flushSpeech();
      rows.push({
        kind: 'gap',
        afterWordGi: cur.gi,
        gapMs: rawGap,
        appliedMs: applied,
        removed,
      });
      speaker = cur.speaker ?? '';
      speech = [cur];
    } else if (speakerChange) {
      flushSpeech();
      speaker = cur.speaker ?? '';
      speech = [cur];
    } else {
      speech.push(cur);
    }
  }
  flushSpeech();
  return rows;
}

/** Speaker accent colors (blue / green / …). */
export function speakerColor(code: string | null | undefined): string {
  if (!code) return '#5b9bff';
  const n = Math.max(0, code.toUpperCase().charCodeAt(0) - 65);
  const palette = ['#5b9bff', '#3ecf8e', '#f0a050', '#d080f0', '#f06080', '#50c8d0'];
  return palette[n % palette.length]!;
}
