import type { TranscriptUtterance, TranscriptWord } from './types';

// 'A' → 'Speaker 1', 'B' → 'Speaker 2', … (AssemblyAI diarization codes).
export function speakerLabel(code: string): string {
  const n = code.charCodeAt(0) - 65;
  return Number.isFinite(n) && n >= 0 ? `Speaker ${n + 1}` : `Speaker ${code}`;
}

export interface Paragraph {
  speaker: string;
  words: TranscriptWord[];
  start: number;
  end: number;
}

// 段落视图: merge CONSECUTIVE same-speaker utterances into reading paragraphs.
export function toParagraphs(utterances: TranscriptUtterance[]): Paragraph[] {
  const out: Paragraph[] = [];
  for (const u of utterances) {
    const last = out[out.length - 1];
    if (last && last.speaker === u.speaker) {
      last.words = [...last.words, ...u.words];
      last.end = u.end;
    } else {
      out.push({ speaker: u.speaker, words: [...u.words], start: u.start, end: u.end });
    }
  }
  return out;
}

export interface Segment {
  speaker: string;
  words: TranscriptWord[];
  start: number;
  end: number;
}

const SENTENCE_END = /[.!?。！?…]$/;

// 片段视图: split each utterance into sentence-level segments (the granular
// editing grain). A segment ends on sentence punctuation or utterance end.
export function toSegments(utterances: TranscriptUtterance[]): Segment[] {
  const out: Segment[] = [];
  for (const u of utterances) {
    let cur: TranscriptWord[] = [];
    for (const w of u.words) {
      cur.push(w);
      if (SENTENCE_END.test(w.text)) {
        out.push({ speaker: u.speaker, words: cur, start: cur[0].start, end: w.end });
        cur = [];
      }
    }
    if (cur.length) out.push({ speaker: u.speaker, words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
  }
  return out;
}

// 停顿 analysis: count gaps between consecutive words longer than thresholdMs and
// how much total time compressing each down to compressToMs would save.
export function analyzeSilences(words: TranscriptWord[], compressToMs: number): { count: number; savedMs: number } {
  let count = 0;
  let savedMs = 0;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap > compressToMs) {
      count++;
      savedMs += gap - compressToMs;
    }
  }
  return { count, savedMs };
}
