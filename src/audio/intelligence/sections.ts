import type { MusicSection, MusicSectionRole } from './types';

export interface MusicSectionInput {
  durationMs: number;
  beatsMs: readonly number[];
  beatEnergy: readonly number[];
}

interface EnergyPoint {
  atMs: number;
  energy: number;
}

interface Boundary {
  atMs: number;
  confidence: number;
}

const MIN_SECTION_MS = 4_000;
const MAX_SECTIONS = 12;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

function mean(values: readonly number[], from = 0, to = values.length): number {
  if (to <= from) return 0;
  let total = 0;
  for (let index = from; index < to; index += 1) total += values[index] ?? 0;
  return total / (to - from);
}

function quantile(values: readonly number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

function normalizeEnergies(values: readonly number[]): number[] {
  const finite = values.map((value) => Number.isFinite(value) ? Math.max(0, value) : 0);
  const low = quantile(finite, 0.05);
  const high = quantile(finite, 0.95);
  if (high - low < 1e-6) return finite.map(() => 0.5);
  return finite.map((value) => clamp01((value - low) / (high - low)));
}

function smooth(values: readonly number[], radius = 2): number[] {
  return values.map((_value, index) => (
    mean(values, Math.max(0, index - radius), Math.min(values.length, index + radius + 1))
  ));
}

function energyPoints(input: MusicSectionInput): EnergyPoint[] {
  const count = Math.min(input.beatsMs.length, input.beatEnergy.length);
  if (!count) return [];
  const normalized = smooth(normalizeEnergies(input.beatEnergy.slice(0, count)));
  const points: EnergyPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const atMs = input.beatsMs[index];
    if (typeof atMs !== 'number' || !Number.isFinite(atMs) || atMs < 0 || atMs > input.durationMs) continue;
    if (points.length && atMs <= points[points.length - 1]!.atMs) continue;
    points.push({ atMs, energy: normalized[index] ?? 0.5 });
  }
  return points;
}

function changeScores(energies: readonly number[]): number[] {
  const scores = new Array<number>(energies.length).fill(0);
  for (let index = 3; index < energies.length - 3; index += 1) {
    const before = mean(energies, index - 3, index);
    const after = mean(energies, index, index + 3);
    scores[index] = Math.abs(after - before);
  }
  return scores;
}

function changeThreshold(scores: readonly number[]): number {
  const candidates = scores.filter((score) => score > 0);
  if (!candidates.length) return 1;
  const average = mean(candidates);
  const variance = mean(candidates.map((score) => (score - average) ** 2));
  return Math.max(0.12, Math.min(0.3, average + Math.sqrt(variance) * 0.7));
}

function rawBoundaries(points: readonly EnergyPoint[], durationMs: number): Boundary[] {
  const scores = changeScores(points.map((point) => point.energy));
  const threshold = changeThreshold(scores);
  const boundaries: Boundary[] = [];
  for (let index = 3; index < points.length - 3; index += 1) {
    const score = scores[index] ?? 0;
    if (score < threshold || score < (scores[index - 1] ?? 0) || score < (scores[index + 1] ?? 0)) continue;
    const atMs = points[index]!.atMs;
    if (atMs < MIN_SECTION_MS || durationMs - atMs < MIN_SECTION_MS) continue;
    boundaries.push({ atMs, confidence: clamp01(0.35 + score * 1.8) });
  }
  return boundaries;
}

function spacedBoundaries(candidates: readonly Boundary[]): Boundary[] {
  const selected: Boundary[] = [];
  for (const candidate of candidates) {
    const prior = selected[selected.length - 1];
    if (!prior || candidate.atMs - prior.atMs >= MIN_SECTION_MS) {
      selected.push(candidate);
    } else if (candidate.confidence > prior.confidence) {
      selected[selected.length - 1] = candidate;
    }
  }
  if (selected.length <= MAX_SECTIONS - 1) return selected;
  return selected
    .toSorted((left, right) => right.confidence - left.confidence)
    .slice(0, MAX_SECTIONS - 1)
    .toSorted((left, right) => left.atMs - right.atMs);
}

function segmentEnergy(points: readonly EnergyPoint[], fromMs: number, toMs: number): number {
  let total = 0;
  let count = 0;
  for (const point of points) {
    if (point.atMs < fromMs || point.atMs >= toMs) continue;
    total += point.energy;
    count += 1;
  }
  if (count) return clamp01(total / count);
  const middle = (fromMs + toMs) / 2;
  const nearest = points.reduce<EnergyPoint | null>((best, point) => (
    !best || Math.abs(point.atMs - middle) < Math.abs(best.atMs - middle) ? point : best
  ), null);
  return nearest?.energy ?? 0.5;
}

function roleFor(index: number, energies: readonly number[]): MusicSectionRole {
  if (energies.length === 1) return 'steady';
  const energy = energies[index] ?? 0.5;
  const previous = energies[index - 1] ?? energy;
  const next = energies[index + 1] ?? energy;
  const middle = quantile(energies, 0.5);
  const high = quantile(energies, 0.75);
  const low = quantile(energies, 0.25);
  if (index === 0 && energy <= middle + 0.12) return 'intro-like';
  if (index === energies.length - 1 && energy <= middle + 0.12) return 'outro-like';
  if (energy >= Math.max(0.58, high)) return 'peak';
  if (energy <= low && (previous - energy > 0.08 || energy < 0.3)) return 'break';
  if (next - energy > 0.08 || energy - previous > 0.12) return 'build';
  return 'steady';
}

function buildSections(points: readonly EnergyPoint[], boundaries: readonly Boundary[], durationMs: number): MusicSection[] {
  const edges = [0, ...boundaries.map((boundary) => boundary.atMs), durationMs];
  const energies = edges.slice(0, -1).map((fromMs, index) => segmentEnergy(points, fromMs, edges[index + 1]!));
  return energies.map((energy, index) => {
    const left = boundaries[index - 1]?.confidence ?? 0.5;
    const right = boundaries[index]?.confidence ?? 0.5;
    return {
      fromMs: Math.round(edges[index]!),
      toMs: Math.round(edges[index + 1]!),
      role: roleFor(index, energies),
      energy: clamp01(energy),
      boundaryConfidence: clamp01((left + right) / 2),
    };
  });
}

/** Deterministic energy-change segmentation; it never reads or mutates project state. */
export function deriveMusicSections(input: MusicSectionInput): MusicSection[] {
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0;
  if (!durationMs) return [];
  const points = energyPoints({ ...input, durationMs });
  if (points.length < 8 || durationMs < MIN_SECTION_MS * 2) {
    const energy = points.length ? mean(points.map((point) => point.energy)) : 0.5;
    return [{ fromMs: 0, toMs: Math.round(durationMs), role: 'steady', energy: clamp01(energy), boundaryConfidence: 0.35 }];
  }
  return buildSections(points, spacedBoundaries(rawBoundaries(points, durationMs)), durationMs);
}
