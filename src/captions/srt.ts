import type { TranscriptWord } from '../transcript/types';

const TIMECODE = /^(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s+-->\s+(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

function milliseconds(hours: string, minutes: string, seconds: string, fraction: string): number {
  return ((Number(hours) * 60 * 60) + (Number(minutes) * 60) + Number(seconds)) * 1000
    + Number(fraction.padEnd(3, '0'));
}

export function parseSrt(source: string): TranscriptWord[] {
  const blocks = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/);
  const cues: TranscriptWord[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => TIMECODE.test(line));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex]!.match(TIMECODE);
    const text = lines.slice(timeIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!match || !text) continue;
    const start = milliseconds(match[1]!, match[2]!, match[3]!, match[4]!);
    const end = milliseconds(match[5]!, match[6]!, match[7]!, match[8]!);
    if (end > start) cues.push({ text, start, end });
  }
  if (!cues.length) throw new Error('No valid SRT cues found.');
  return cues;
}
