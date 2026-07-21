import type { TranscriptWord } from './types';

export type SilenceRule =
  | { mode: 'compress'; maxMs: number }
  | { mode: 'restore'; minMs: number }
  | { mode: 'normalize'; targetMs: number }
  | { mode: 'range'; minMs: number; maxMs: number }
  | { mode: 'long'; thresholdMs: number; targetMs: number };

function positiveMs(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number of milliseconds`);
  return Math.round(parsed);
}

/** Parse named and legacy silence cleanup syntax into one typed rule. */
export function parseSilenceRule(value: unknown): SilenceRule | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const rule = value.trim().toLowerCase().replace(/\s+/g, '');
  let match = /^(compress|max):(\d+(?:\.\d+)?)$/.exec(rule);
  if (match) return { mode: 'compress', maxMs: positiveMs(match[2], 'compress') };
  match = /^(restore|min):(\d+(?:\.\d+)?)$/.exec(rule);
  if (match) return { mode: 'restore', minMs: positiveMs(match[2], 'restore') };
  match = /^normalize:(\d+(?:\.\d+)?)$/.exec(rule);
  if (match) return { mode: 'normalize', targetMs: positiveMs(match[1], 'normalize') };
  match = /^range:(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/.exec(rule);
  if (!match) match = /^min:(\d+(?:\.\d+)?),max:(\d+(?:\.\d+)?)$/.exec(rule);
  if (match) {
    const minMs = positiveMs(match[1], 'range minimum');
    const maxMs = positiveMs(match[2], 'range maximum');
    if (minMs > maxMs) throw new Error('silence range minimum cannot exceed maximum');
    return { mode: 'range', minMs, maxMs };
  }
  if (/^\d+(?:\.\d+)?$/.test(rule)) return { mode: 'normalize', targetMs: positiveMs(rule, 'normalize') };
  throw new Error(`invalid silence rule "${value}"`);
}

export function parseCleanOnly(value: unknown): { fillers: boolean; silence: boolean } {
  if (value == null || value === '') return { fillers: true, silence: true };
  if (typeof value !== 'string') throw new Error('only must be "fillers", "silence", or "fillers,silence"');
  const parts = new Set(value.toLowerCase().split(',').map((part) => part.trim()).filter(Boolean));
  if (!parts.size || [...parts].some((part) => part !== 'fillers' && part !== 'silence')) {
    throw new Error('only must be "fillers", "silence", or "fillers,silence"');
  }
  return { fillers: parts.has('fillers'), silence: parts.has('silence') };
}

function appliedGapMs(rawMs: number, wordIndex: number, globalCapMs: number | undefined, caps: Record<string, number>): number {
  const specific = caps[String(wordIndex)];
  const cap = specific ?? globalCapMs;
  return cap == null ? rawMs : Math.min(rawMs, Math.max(0, cap));
}

/** Build per-boundary caps. A result never exceeds the source-recorded gap. */
export function buildSilenceGapCaps(
  words: TranscriptWord[],
  rule: SilenceRule,
  current: { silenceFrames?: number; fps: number; gapCapsMs?: Record<string, number> },
): Record<string, number> | undefined {
  if (words.length < 2) return current.gapCapsMs;
  const caps = { ...(current.gapCapsMs ?? {}) };
  const globalCapMs = current.silenceFrames == null
    ? undefined
    : Math.round((current.silenceFrames / current.fps) * 1000);
  for (let index = 1; index < words.length; index += 1) {
    const rawMs = Math.max(0, Math.round(words[index]!.start - words[index - 1]!.end));
    const appliedMs = appliedGapMs(rawMs, index, globalCapMs, caps);
    let desiredMs = appliedMs;
    switch (rule.mode) {
      case 'compress':
        desiredMs = Math.min(appliedMs, rule.maxMs);
        break;
      case 'restore':
        desiredMs = Math.min(rawMs, Math.max(appliedMs, rule.minMs));
        break;
      case 'normalize':
        desiredMs = Math.min(rawMs, rule.targetMs);
        break;
      case 'range':
        desiredMs = Math.min(rawMs, Math.max(rule.minMs, Math.min(appliedMs, rule.maxMs)));
        break;
      case 'long':
        if (rawMs >= rule.thresholdMs) desiredMs = Math.min(appliedMs, rule.targetMs);
        break;
    }
    if (desiredMs !== rawMs || String(index) in caps || globalCapMs != null) caps[String(index)] = desiredMs;
  }
  return Object.keys(caps).length ? caps : undefined;
}
