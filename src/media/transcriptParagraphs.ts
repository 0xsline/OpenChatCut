import type { TranscriptWord } from '../transcript/types';

/** Format word-level milliseconds as m:ss. */
export function transcriptTimestamp(milliseconds: number): string {
  const whole = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export interface TranscriptParagraph {
  /** Paragraph start time (first word), in milliseconds. */
  start: number;
  text: string;
}

/** Split word-level transcript into readable paragraphs. A gap longer than
 *  `gapMs` between consecutive words opens a new paragraph, so each
 *  paragraph reads as one spoken phrase with a stable start timestamp. */
export function transcriptParagraphs(words: readonly TranscriptWord[], gapMs = 800): TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptParagraph | null = null;
  let lastEnd = 0;
  for (const word of words) {
    if (current && word.start - lastEnd > gapMs) {
      paragraphs.push(current);
      current = null;
    }
    if (!current) {
      current = { start: word.start, text: word.text };
    } else {
      current.text += word.text;
    }
    lastEnd = word.end;
  }
  if (current) paragraphs.push(current);
  return paragraphs;
}
