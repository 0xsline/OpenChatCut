import type { TimelineItem } from '../editor/types';
import type { TranscriptWord } from '../transcript/types';
import { normalizeCaptionSourceEntries } from './sourceOrder';
import type { CaptionsData, CaptionSourceEntry } from './types';

const DEFAULT_CUE_MS = 3_000;

const id = (): string => `lane_${crypto.randomUUID()}`;

export function isManualCaptionEntry(entry: CaptionSourceEntry): boolean {
  return Array.isArray(entry.words);
}

export function newManualCaptions(): CaptionsData {
  return {
    enabled: true,
    template: 'black-bar',
    pacing: 'phrase',
    sourceEntries: [newManualEntry(1)],
    sourceMode: 'item',
  };
}

export function newManualEntry(number: number): CaptionSourceEntry {
  const laneId = id();
  return {
    id: laneId,
    itemId: `manual:${laneId}`,
    label: `手动字幕 ${number}`,
    words: [],
  };
}

export function promoteCaptionEntries(captions: CaptionsData, items: TimelineItem[]): CaptionSourceEntry[] {
  if (captions.sourceEntries?.length) return normalizeCaptionSourceEntries(captions.sourceEntries);
  const ids = sourceIds(captions, items);
  const entries: CaptionSourceEntry[] = ids.map((itemId) => ({ id: id(), itemId }));
  if (captions.words) entries.push({ ...newManualEntry(1), words: captions.words.map((word) => ({ ...word })) });
  return normalizeCaptionSourceEntries(entries);
}

function sourceIds(captions: CaptionsData, items: TimelineItem[]): string[] {
  if (captions.sourceMode === 'timeline') {
    return items.filter((item) => item.transcript?.length).map((item) => item.id);
  }
  if (captions.sources?.length) return captions.sources;
  return captions.sourceItemId ? [captions.sourceItemId] : [];
}

export function appendManualLane(captions: CaptionsData, items: TimelineItem[]): Partial<CaptionsData> {
  const entries = promoteCaptionEntries(captions, items);
  const count = entries.filter(isManualCaptionEntry).length;
  return entryPatch([...entries, newManualEntry(count + 1)]);
}

export function removeManualLane(captions: CaptionsData, laneId: string): Partial<CaptionsData> {
  return entryPatch((captions.sourceEntries ?? []).filter((entry) => entry.id !== laneId));
}

export function appendManualCue(
  captions: CaptionsData,
  laneId: string,
  text: string,
  startMs: number,
  endMs = startMs + DEFAULT_CUE_MS,
): Partial<CaptionsData> | null {
  const cue = manualCue(text, startMs, endMs);
  if (!cue) return null;
  return mapManualLane(captions, laneId, (words) => [...words, cue].sort((a, b) => a.start - b.start));
}

export function updateManualCue(
  captions: CaptionsData,
  laneId: string,
  index: number,
  text: string,
  startMs: number,
  endMs: number,
): Partial<CaptionsData> | null {
  const cue = manualCue(text, startMs, endMs);
  if (!cue) return null;
  return mapManualLane(captions, laneId, (words) =>
    words.map((word, i) => i === index ? cue : word).sort((a, b) => a.start - b.start),
  );
}

export function removeManualCue(captions: CaptionsData, laneId: string, index: number): Partial<CaptionsData> {
  return mapManualLane(captions, laneId, (words) => words.filter((_, i) => i !== index));
}

function manualCue(text: string, startMs: number, endMs: number): TranscriptWord | null {
  const clean = text.trim();
  if (!clean || !Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const start = Math.max(0, Math.round(startMs));
  const end = Math.max(start + 1, Math.round(endMs));
  return { text: clean, start, end };
}

function mapManualLane(
  captions: CaptionsData,
  laneId: string,
  update: (words: TranscriptWord[]) => TranscriptWord[],
): Partial<CaptionsData> {
  const entries = (captions.sourceEntries ?? []).map((entry) =>
    entry.id === laneId && isManualCaptionEntry(entry)
      ? { ...entry, words: update(entry.words ?? []) }
      : entry,
  );
  return entryPatch(entries);
}

function entryPatch(entries: CaptionSourceEntry[]): Partial<CaptionsData> {
  return {
    sourceEntries: normalizeCaptionSourceEntries(entries),
    sources: undefined,
    sourceMode: 'item',
    words: undefined,
  };
}
