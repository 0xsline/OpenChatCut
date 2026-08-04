import type { TranscriptWord } from '../transcript/types';
import { kindOfDescriptor, type MediaKind } from './mediaProbe';

export type ExternalFileTarget =
  | { type: 'media'; mediaKind: MediaKind }
  | { type: 'caption'; format: 'srt' | 'vtt' | 'txt' };

type FileDescriptor = Pick<File, 'name' | 'type'>;

const CAPTION_FORMATS = new Map<string, 'srt' | 'vtt' | 'txt'>([
  ['.srt', 'srt'], ['.vtt', 'vtt'], ['.txt', 'txt'],
]);

export function classifyExternalFile(file: FileDescriptor): ExternalFileTarget | null {
  const lowerName = file.name.toLowerCase();
  const caption = [...CAPTION_FORMATS].find(([extension]) => lowerName.endsWith(extension));
  if (caption) return { type: 'caption', format: caption[1] };
  const mediaKind = kindOfDescriptor(file.name, file.type);
  return mediaKind ? { type: 'media', mediaKind } : null;
}

export function hasExternalFiles(dataTransfer: DataTransfer): boolean {
  return dataTransfer.files.length > 0 || Array.from(dataTransfer.types).includes('Files');
}

export function droppedFiles(dataTransfer: DataTransfer): File[] {
  return Array.from(dataTransfer.files);
}

function parseTimestamp(raw: string): number | null {
  const match = raw.trim().match(/^(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const milliseconds = Number((match[4] ?? '').padEnd(3, '0'));
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function timedCaptionWords(text: string): TranscriptWord[] {
  const source = text.replace(/^\uFEFF/, '').replace(/^WEBVTT[^\n]*\n?/i, '').replace(/\r/g, '');
  const words: TranscriptWord[] = [];
  for (const block of source.split(/\n{2,}/)) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes('-->'));
    if (timingIndex < 0) continue;
    const [from, to] = lines[timingIndex]!.split('-->').map((value) => value.trim().split(/\s+/)[0] ?? '');
    const start = parseTimestamp(from);
    const end = parseTimestamp(to);
    const captionText = lines.slice(timingIndex + 1)
      .filter((line) => !/^(NOTE|STYLE|REGION)\b/i.test(line)).join(' ').trim();
    if (start === null || end === null || end <= start || !captionText) continue;
    words.push({ text: captionText, start, end });
  }
  return words;
}

/** Parse a Finder-dropped caption file and make its first cue begin at the drop frame. */
export function parseDroppedCaptions(name: string, text: string, dropStartMs: number): TranscriptWord[] {
  const target = classifyExternalFile({ name, type: '' });
  const timed = target?.type === 'caption' && target.format !== 'txt' ? timedCaptionWords(text) : [];
  if (timed.length) {
    const offset = Math.max(0, dropStartMs) - timed[0]!.start;
    return timed.map((word) => ({
      ...word,
      start: Math.max(0, word.start + offset),
      end: Math.max(1, word.end + offset),
    }));
  }
  const start = Math.max(0, dropStartMs);
  return text.replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean)
    .map((line, index) => ({
      text: line,
      start: start + index * 3000,
      end: start + (index + 1) * 3000,
    }));
}
