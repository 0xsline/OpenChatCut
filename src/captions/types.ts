import type { TranscriptWord } from '../transcript/types';

// Captions (字幕) = a styled overlay burned onto the video, separate from the
// 文字稿 editing surface. Words are paginated into "pages" and shown in sync
// with playback. Timestamps are ms relative to the SOURCE clip; offsetFrames is
// where that clip sits on the timeline.
export type CaptionTemplate = 'plain' | 'tiktok' | 'netflix';
export type CaptionPacing = 'word' | 'phrase';

export interface CaptionsData {
  enabled: boolean;
  template: CaptionTemplate;
  pacing: CaptionPacing;
  offsetFrames: number;
  words: TranscriptWord[];
}

export interface CaptionPage {
  words: TranscriptWord[];
  start: number; // ms
  end: number; // ms
}

const SENTENCE_END = /[.!?。！?…,,]$/;
const MAX_PHRASE_WORDS = 6;
const GAP_MS = 700;
const LINGER_MS = 1500;

// Group words into display pages: one word each (word pacing), or short phrases
// broken on punctuation / length / a big pause (phrase pacing).
export function paginate(words: TranscriptWord[], pacing: CaptionPacing): CaptionPage[] {
  if (pacing === 'word') return words.map((w) => ({ words: [w], start: w.start, end: w.end }));
  const pages: CaptionPage[] = [];
  let cur: TranscriptWord[] = [];
  const flush = () => {
    if (cur.length) pages.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    cur.push(words[i]);
    const next = words[i + 1];
    const bigGap = next ? next.start - words[i].end > GAP_MS : false;
    if (cur.length >= MAX_PHRASE_WORDS || SENTENCE_END.test(words[i].text) || bigGap) flush();
  }
  flush();
  return pages;
}

// The page to show at time `ms`: the latest page whose start has passed, held
// until the next page starts (or LINGER_MS after the last page's end).
export function activePage(pages: CaptionPage[], ms: number): CaptionPage | null {
  for (let i = pages.length - 1; i >= 0; i--) {
    if (ms >= pages[i].start) {
      const until = pages[i + 1]?.start ?? pages[i].end + LINGER_MS;
      return ms < until ? pages[i] : null;
    }
  }
  return null;
}

// Index of the word currently being spoken within a page (for karaoke highlight).
export function currentWordIndex(page: CaptionPage, ms: number): number {
  let idx = 0;
  for (let i = 0; i < page.words.length; i++) if (ms >= page.words[i].start) idx = i;
  return idx;
}
