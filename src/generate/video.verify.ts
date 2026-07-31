import assert from 'node:assert/strict';
import type { TimelineState } from '../editor/types';
import {
  GenerationReferencePreflightError,
  preflightGenerationReferences,
  submitVideo,
  type GenerationReference,
} from './video';

const state = {
  fps: 25,
  width: 1920,
  height: 1080,
  tracks: [],
  items: [{
    id: 'clip-1',
    track: 'V1',
    startFrame: 50,
    durationInFrames: 50,
    name: 'Trimmed source',
    kind: 'video',
    src: '/media/uploads/source.mp4',
    srcInFrame: 100,
    playbackRate: 2,
    sourceRevision: 'clip-revision-2',
  }],
  assets: [{
    id: 'asset-1',
    name: 'Source master',
    kind: 'video',
    src: '/media/uploads/source.mp4',
    durationInFrames: 600,
    sourceRevision: 'asset-revision-1',
  }],
} as unknown as TimelineState;

const originalFetch = globalThis.fetch;
let submitted: Record<string, unknown> | undefined;
globalThis.fetch = (async (_input, init) => {
  submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
  return new Response(JSON.stringify({
    operationId: submitted.operationId,
    jobId: submitted.operationId,
    status: 'queued',
    provider: 'kling',
    providerTaskId: 'provider-1',
  }), { status: 202, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

try {
  await submitVideo({
    operationId: 'operation-1',
    model: 'kling',
    prompt: 'Keep the visible action',
    refVideos: ['clip-1'],
  }, state);
} finally {
  globalThis.fetch = originalFetch;
}

const references = submitted?.generationReferences as GenerationReference[];
assert.equal(references.length, 1);
assert.deepEqual(references[0], {
  kind: 'timeline-slice',
  role: 'reference-video',
  assetId: 'asset-1',
  itemId: 'clip-1',
  path: '/media/uploads/source.mp4',
  sourceRevision: 'clip-revision-2',
  srcInFrame: 100,
  srcOutFrame: 200,
  playbackRate: 2,
  timelineDurationInFrames: 50,
  fps: 25,
}, 'a timeline reference must retain its visible source window instead of falling back to the full asset');
assert.deepEqual(submitted?.sourceRevisions, ['clip-revision-2']);

assert.throws(
  () => preflightGenerationReferences('kling', [{
    kind: 'asset-master',
    role: 'reference-audio',
    assetId: 'audio-1',
    path: '/media/uploads/reference.wav',
  }]),
  (error: unknown) => error instanceof GenerationReferencePreflightError
    && error.issues.some((issue) => issue.code === 'kling_audio_unsupported'),
  'unsupported provider/model/role combinations must fail before fetch',
);

console.log('video generation reference checks passed');
