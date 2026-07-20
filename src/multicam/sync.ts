// Client-side multicam sync for runAiMulticamSync / multicam_sync.
// Decode each clip's media audio → cross-correlate vs a reference → shift
// follower startFrame so picture lines up with the reference audio. No backend.
import type { TimelineItem, TimelineState } from '../editor/types';
import { findLag, prepareSignal, TARGET_RATE, type AlignResult } from './align';

const MIN_CONFIDENCE = 0.08; // below this we skip (silence / unrelated audio)
const MIN_SHIFT_FRAMES = 1;  // ignore sub-frame noise

export type MulticamStatus = 'applied' | 'already_synced' | 'failed' | 'partial';

export interface MulticamSyncResult {
  status: MulticamStatus;
  changed: boolean;
  referenceItemId: string;
  syncedItemIds: string[];
  skippedItemIds: string[];
  /** per-follower diagnostics */
  offsets: Array<{ itemId: string; lagSeconds: number; confidence: number; deltaFrames: number }>;
  message: string;
  /** next timeline state when changed (caller applies as one undo step) */
  nextState?: TimelineState;
}

export function canMulticamItem(it: TimelineItem): boolean {
  if (it.kind === 'audio') return !!it.src;
  if (it.kind === 'video') return !!it.src;
  return false;
}

async function decodeMono(src: string): Promise<{ samples: Float32Array; sampleRate: number } | { error: string }> {
  try {
    const res = await fetch(src);
    if (!res.ok) return { error: `fetch failed (${res.status})` };
    const buf = await res.arrayBuffer();
    // OfflineAudioContext exists in browser; length is placeholder
    const Offline = (globalThis as unknown as { OfflineAudioContext?: typeof OfflineAudioContext }).OfflineAudioContext;
    if (!Offline) return { error: 'OfflineAudioContext unavailable' };
    const probe = new Offline(1, 1, 44100);
    const audio = await probe.decodeAudioData(buf.slice(0));
    const channels: Float32Array[] = [];
    for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
    const samples = prepareSignal(channels, audio.length, audio.sampleRate);
    if (samples.length < 64) return { error: 'audio too short' };
    return { samples, sampleRate: TARGET_RATE };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

function resolveSrc(it: TimelineItem, assets: TimelineState['assets']): string | null {
  if (it.src) return it.src;
  // pool asset fallback by name match is not reliable; need assetId if we had it
  void assets;
  return null;
}

/**
 * Run multicam sync on selected clips.
 * - referenceItemId defaults to the first video-kind item, else earliest startFrame
 * - only items with decodable audio are aligned; others skipped
 */
export async function runMulticamSync(args: {
  state: TimelineState;
  itemIds: string[];
  referenceItemId?: string;
}): Promise<MulticamSyncResult> {
  const { state } = args;
  const ids = [...new Set(args.itemIds.map(String).filter(Boolean))];
  const items = ids.map((id) => state.items.find((x) => x.id === id || x.id.startsWith(id))).filter((x): x is TimelineItem => !!x);
  if (items.length < 2) {
    return {
      status: 'failed', changed: false, referenceItemId: '',
      syncedItemIds: [], skippedItemIds: ids,
      offsets: [], message: 'Select 2 or more video/audio clips first.',
    };
  }
  const eligible = items.filter(canMulticamItem);
  if (eligible.length < 2) {
    return {
      status: 'failed', changed: false, referenceItemId: '',
      syncedItemIds: [], skippedItemIds: items.map((x) => x.id),
      offsets: [], message: 'Multicam sync only works on video or audio clips with media.',
    };
  }

  let refId = args.referenceItemId?.trim() || '';
  if (refId) {
    const hit = eligible.find((x) => x.id === refId || x.id.startsWith(refId));
    if (!hit) {
      return {
        status: 'failed', changed: false, referenceItemId: refId,
        syncedItemIds: [], skippedItemIds: eligible.map((x) => x.id),
        offsets: [], message: 'referenceItemId must be one of the selected clips.',
      };
    }
    refId = hit.id;
  } else {
    // prefer a video clip as reference (picture A-cam), else earliest
    const video = eligible.find((x) => x.kind === 'video');
    refId = (video ?? [...eligible].sort((a, b) => a.startFrame - b.startFrame)[0]!).id;
  }
  const refItem = eligible.find((x) => x.id === refId)!;
  const refSrc = resolveSrc(refItem, state.assets);
  if (!refSrc) {
    return {
      status: 'failed', changed: false, referenceItemId: refId,
      syncedItemIds: [], skippedItemIds: eligible.map((x) => x.id),
      offsets: [], message: 'Reference clip cannot be used for audio sync (no media src).',
    };
  }

  const refDecoded = await decodeMono(refSrc);
  if ('error' in refDecoded) {
    return {
      status: 'failed', changed: false, referenceItemId: refId,
      syncedItemIds: [], skippedItemIds: eligible.map((x) => x.id),
      offsets: [], message: `Reference audio decode failed: ${refDecoded.error}`,
    };
  }

  const fps = state.fps || 30;
  const followers = eligible.filter((x) => x.id !== refId);
  const offsets: MulticamSyncResult['offsets'] = [];
  const syncedItemIds: string[] = [];
  const skippedItemIds: string[] = [];
  const moves = new Map<string, number>(); // id → new startFrame

  for (const it of followers) {
    const src = resolveSrc(it, state.assets);
    if (!src) {
      skippedItemIds.push(it.id);
      continue;
    }
    const dec = await decodeMono(src);
    if ('error' in dec) {
      skippedItemIds.push(it.id);
      continue;
    }
    const align: AlignResult = findLag(refDecoded.samples, dec.samples, TARGET_RATE);
    if (align.confidence < MIN_CONFIDENCE) {
      skippedItemIds.push(it.id);
      offsets.push({ itemId: it.id, lagSeconds: align.lagSeconds, confidence: align.confidence, deltaFrames: 0 });
      continue;
    }
    // lagSeconds > 0 → other delayed in content → move other earlier on timeline
    // Also keep relative: ref stays; follower startFrame' = startFrame - lag*fps
    // so that the matching content lines up at the same timeline moment as ref.
    const deltaFrames = Math.round(-align.lagSeconds * fps);
    offsets.push({
      itemId: it.id,
      lagSeconds: align.lagSeconds,
      confidence: align.confidence,
      deltaFrames,
    });
    if (Math.abs(deltaFrames) < MIN_SHIFT_FRAMES) {
      // already aligned enough
      continue;
    }
    const nextStart = Math.max(0, it.startFrame + deltaFrames);
    if (nextStart !== it.startFrame) {
      moves.set(it.id, nextStart);
      syncedItemIds.push(it.id);
    }
  }

  if (moves.size === 0) {
    return {
      status: skippedItemIds.length === followers.length ? 'failed' : 'already_synced',
      changed: false,
      referenceItemId: refId,
      syncedItemIds: [],
      skippedItemIds,
      offsets,
      message: skippedItemIds.length === followers.length
        ? 'Could not align any follower clips (low confidence or decode failed).'
        : 'Multicam already synced (offsets under 1 frame).',
    };
  }

  const nextItems = state.items.map((it) => {
    const start = moves.get(it.id);
    return start === undefined ? it : { ...it, startFrame: start };
  });
  const nextState: TimelineState = { ...state, items: nextItems };
  const status: MulticamStatus = skippedItemIds.length ? 'partial' : 'applied';
  return {
    status,
    changed: true,
    referenceItemId: refId,
    syncedItemIds,
    skippedItemIds,
    offsets,
    message: status === 'partial'
      ? `Multicam sync applied to ${syncedItemIds.length}; skipped ${skippedItemIds.length}.`
      : `Multicam sync applied (${syncedItemIds.length} clip${syncedItemIds.length === 1 ? '' : 's'}).`,
    nextState,
  };
}
