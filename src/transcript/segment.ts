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

// 'A' → '说话人 1', 'B' → '说话人 2', … (AssemblyAI diarization codes).
export function speakerLabel(code: string | null | undefined): string {
  if (!code) return '说话人';
  const n = code.charCodeAt(0) - 65;
  return Number.isFinite(n) && n >= 0 ? `说话人 ${n + 1}` : `说话人 ${code}`;
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

// 段落视图: merge CONSECUTIVE same-speaker words into reading paragraphs.
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

// 片段视图: split into sentence-level segments (the granular editing grain).
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

// 停顿 analysis: count gaps between consecutive words longer than compressToMs
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
