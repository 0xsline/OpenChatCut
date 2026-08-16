import type { TranscriptWord } from '../transcript/types';

/** Format seconds as m:ss. */
export function transcriptTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const secs = whole % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

export interface TranscriptParagraph {
  /** Paragraph start time (first word), in seconds. */
  start: number;
  text: string;
}

/** Split word-level transcript into readable paragraphs. A gap longer than
 *  `gapSeconds` between consecutive words opens a new paragraph, so each
 *  paragraph reads as one spoken phrase with a stable start timestamp. */
export function transcriptParagraphs(words: readonly TranscriptWord[], gapSeconds = 0.8): TranscriptParagraph[] {
  const paragraphs: TranscriptParagraph[] = [];
  let current: TranscriptParagraph | null = null;
  let lastEnd = 0;
  for (const word of words) {
    if (current && word.start - lastEnd > gapSeconds) {
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
