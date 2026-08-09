import { totalmem } from 'node:os';
import { ASR_MODELS } from '../shared/asr-models.ts';
import { MODEL_PACKS, type ModelPackId } from '../shared/model-packs/catalog.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const ASR_RUNTIME_MULTIPLIER = 3;
const MIN_ASR_RESIDENT_BYTES = 512 * MIB;
const UNKNOWN_ASR_RESIDENT_BYTES = 2 * GIB;
const MIN_RESIDENT_LIMIT = 1 * GIB;
const MAX_RESIDENT_LIMIT = 4 * GIB;
const RESIDENT_MEMORY_FRACTION = 0.25;

export type NativeInferenceKind = 'asr' | 'semantic' | 'clap' | 'rhythm';

interface ResidentEntry {
  active: number;
  bytes: number;
  lastUsed: number;
}

export function defaultNativeResidencyLimit(totalMemory = totalmem()): number {
  const proportional = Math.floor(totalMemory * RESIDENT_MEMORY_FRACTION);
  return Math.max(MIN_RESIDENT_LIMIT, Math.min(MAX_RESIDENT_LIMIT, proportional));
}

export function estimateAsrResidentBytes(modelId: string, revision: string): number {
  const model = ASR_MODELS.find((entry) => entry.modelId === modelId && entry.revision === revision);
  if (!model) return UNKNOWN_ASR_RESIDENT_BYTES;
  const installedBytes = model.files.reduce((total, file) => total + file.sizeBytes, 0);
  return Math.max(MIN_ASR_RESIDENT_BYTES, installedBytes * ASR_RUNTIME_MULTIPLIER);
}

export function modelPackResidentBytes(id: ModelPackId): number {
  const pack = MODEL_PACKS.find((entry) => entry.id === id);
  if (!pack) throw new Error(`unknown native model pack: ${id}`);
  return pack.recommendedMemoryBytes;
}

export class NativeInferenceResidency {
  private readonly entries = new Map<NativeInferenceKind, ResidentEntry>();
  private clock = 0;
  private readonly limitBytes: number;


  constructor(limitBytes = defaultNativeResidencyLimit()) {
    this.limitBytes = limitBytes;
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0) {
      throw new Error('invalid native inference resident memory limit');
    }
  }

  claim(
    kind: NativeInferenceKind,
    bytes: number,
    evict: (kind: NativeInferenceKind) => void,
  ): () => void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('invalid native inference resident memory estimate');
    }
    const current = this.entries.get(kind);
    const additionalBytes = Math.max(0, bytes - (current?.bytes ?? 0));
    this.evictIdleUntilFits(kind, additionalBytes, evict);
    if (this.totalBytes() + additionalBytes > this.limitBytes) {
      throw new Error('desktop native inference resident memory limit exceeded');
    }
    const entry = current ?? { active: 0, bytes, lastUsed: 0 };
    entry.active += 1;
    entry.bytes = Math.max(entry.bytes, bytes);
    entry.lastUsed = this.nextClock();
    this.entries.set(kind, entry);
    return () => this.release(kind);
  }

  clear(): void {
    this.entries.clear();
  }

  residentKinds(): NativeInferenceKind[] {
    return [...this.entries.keys()];
  }

  private evictIdleUntilFits(
    requestedKind: NativeInferenceKind,
    additionalBytes: number,
    evict: (kind: NativeInferenceKind) => void,
  ): void {
    const candidates = [...this.entries.entries()]
      .filter(([kind, entry]) => kind !== requestedKind && entry.active === 0)
      .toSorted((left, right) => left[1].lastUsed - right[1].lastUsed);
    for (const [kind] of candidates) {
      if (this.totalBytes() + additionalBytes <= this.limitBytes) return;
      evict(kind);
      this.entries.delete(kind);
    }
  }

  private release(kind: NativeInferenceKind): void {
    const entry = this.entries.get(kind);
    if (!entry || entry.active === 0) return;
    entry.active -= 1;
    entry.lastUsed = this.nextClock();
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    return total;
  }

  private nextClock(): number {
    this.clock += 1;
    return this.clock;
  }
}
