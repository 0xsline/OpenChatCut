import type { TranscriptWord } from '../transcript/types';

const TIMECODE = /^(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})\s*-->\s*(\d{1,3}):([0-5]\d):([0-5]\d)[,.](\d{1,3})(?:\s+.*)?$/;

function milliseconds(hours: string, minutes: string, seconds: string, fraction: string): number {
  return ((Number(hours) * 60 * 60) + (Number(minutes) * 60) + Number(seconds)) * 1000
    + Number(fraction.padEnd(3, '0'));
}

function decodeEntity(entity: string): string {
  const named: Record<string, string> = {
    amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"', '#39': "'",
  };
  const key = entity.slice(1, -1).toLowerCase();
  if (key in named) return named[key]!;
  const numeric = key.startsWith('#x')
    ? Number.parseInt(key.slice(2), 16)
    : key.startsWith('#')
      ? Number.parseInt(key.slice(1), 10)
      : Number.NaN;
  return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0x10ffff
    ? String.fromCodePoint(numeric)
    : entity;
}

function cueText(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/<\/?(?:b|i|u|font)(?:\s+[^>]*)?>/gi, '')
    .replace(/\{\\[^}]+\}/g, '')
    .replace(/&(?:amp|apos|gt|lt|nbsp|quot|#39|#\d+|#x[\da-f]+);/gi, decodeEntity)
    .trim();
}

export function parseSrt(source: string): TranscriptWord[] {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  const cues: TranscriptWord[] = [];
  for (const block of normalized ? normalized.split(/\n[ \t]*\n+/) : []) {
    const lines = block.split('\n');
    const timeIndex = lines.findIndex((line) => TIMECODE.test(line.trim()));
    if (timeIndex < 0) continue;
    const match = lines[timeIndex]!.trim().match(TIMECODE);
    const text = cueText(lines.slice(timeIndex + 1));
    if (!match || !text) continue;
    const start = milliseconds(match[1]!, match[2]!, match[3]!, match[4]!);
    const end = milliseconds(match[5]!, match[6]!, match[7]!, match[8]!);
    if (end > start) cues.push({ text, start, end });
  }
  if (!cues.length) throw new Error('SRT 文件中没有有效字幕。');
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}
