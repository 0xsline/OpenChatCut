import assert from 'node:assert/strict';
import type { MediaAsset, TimelineItem, TimelineState } from '../../editor/types';
import {
  applyLibraryDropIsolation,
  type IsolateVoiceSource,
  type LibraryDropIsolationContext,
} from './libraryDropIsolation';

const sourceRevision = 'source-drop-original';
const sourceAsset: MediaAsset = {
  id: 'asset_voice',
  name: 'Voice',
  kind: 'audio',
  src: '/media/uploads/voice.wav',
  durationInFrames: 300,
  sourceRevision,
};
const sourceItem: TimelineItem = {
  id: 'clip_voice',
  track: 'A1',
  startFrame: 0,
  durationInFrames: 300,
  name: 'Voice',
  kind: 'audio',
  src: sourceAsset.src,
  sourceRevision: 'source-item-stale-copy',
};
const initialState: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [sourceItem],
  assets: [sourceAsset],
  selectedId: null,
  tracks: { A1: { kind: 'audio' } },
  trackOrder: ['A1'],
};

interface VerifyIsolationResult {
  path: string;
  sourceRevision: string;
  strength: number;
  engine?: string;
}

function deferredIsolation() {
  let resolve!: (result: VerifyIsolationResult) => void;
  const promise = new Promise<VerifyIsolationResult>((done) => { resolve = done; });
  return { promise, resolve };
}

let liveState = initialState;
let denoiseWrites = 0;
let lastDenoisedSrc: string | undefined;
const context: LibraryDropIsolationContext = {
  getState: () => liveState,
  getAssets: () => liveState.assets ?? [],
  setItemDenoise: (_itemId, denoisedSrc) => {
    denoiseWrites += 1;
    lastDenoisedSrc = denoisedSrc;
  },
};

const pending = deferredIsolation();
const submitted: {
  value?: { src: string; strength: number; sourceRevision: string };
} = {};
const isolatePending: IsolateVoiceSource = async (src, strength, options) => {
  submitted.value = { src, strength, sourceRevision: options.sourceRevision };
  return pending.promise;
};
const stalePromise = applyLibraryDropIsolation(sourceItem, 70, context, isolatePending);
assert.deepEqual(submitted.value, {
  src: sourceAsset.src,
  strength: 70,
  sourceRevision,
}, 'drop captures the associated asset revision instead of the stale item copy');

const relinkedRevision = 'source-drop-relinked';
const relinkedSrc = '/media/uploads/voice-relinked.wav';
const relinkedAsset: MediaAsset = { ...sourceAsset, src: relinkedSrc, sourceRevision: relinkedRevision };
const relinkedItem: TimelineItem = { ...sourceItem, src: relinkedSrc, sourceRevision: relinkedRevision };
liveState = { ...liveState, items: [relinkedItem], assets: [relinkedAsset] };
pending.resolve({
  path: '/media/uploads/voice-stale-isolated.wav',
  sourceRevision,
  strength: 70,
});

const stale = await stalePromise;
assert(stale.status === 'stale', 'same-id relink must be stale');
assert.equal(stale.reason, 'item_source_changed');
assert.equal('denoisedSrc' in stale, false, 'stale result discards the derived URL');
assert.equal(denoiseWrites, 0, 'same-id relink while pending must never reach setItemDenoise');
assert.equal(lastDenoisedSrc, undefined);

const isolateCurrent: IsolateVoiceSource = async (src, strength, options) => ({
  path: '/media/uploads/voice-relinked-isolated.wav',
  sourceRevision: options.sourceRevision,
  strength,
  engine: `verify:${src}`,
});
const committed = await applyLibraryDropIsolation(relinkedItem, 65, context, isolateCurrent);
assert.equal(committed.status, 'committed');
assert.equal(denoiseWrites, 1, 'unchanged source commits exactly once');
assert.equal(lastDenoisedSrc, '/media/uploads/voice-relinked-isolated.wav');

const isolateMismatched: IsolateVoiceSource = async (_src, strength) => ({
  path: '/media/uploads/voice-mismatched-isolated.wav',
  sourceRevision: 'source-drop-server-mismatch',
  strength,
});
const mismatch = await applyLibraryDropIsolation(relinkedItem, 65, context, isolateMismatched);
assert(mismatch.status === 'stale', 'server revision mismatch must be stale');
assert.equal(mismatch.reason, 'result_revision_mismatch');
assert.equal(denoiseWrites, 1, 'server revision mismatch must not commit');
assert.equal(lastDenoisedSrc, '/media/uploads/voice-relinked-isolated.wav');

console.log('libraryDropActions.verify: deferred relink, current success, and server revision mismatch guarded');
