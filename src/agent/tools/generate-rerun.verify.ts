import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import { resetJobRegistryMemory } from '../../persist/jobRegistryStore';
import {
  canonicalGenerationArgs,
  execGenerateTool,
  generationIdempotencyKey,
  resetGenerationIdempotencyMemory,
} from './generate-tools';

assert.equal(
  canonicalGenerationArgs({ z: [undefined, { n: Number.NaN, zero: -0 }], a: 1 }),
  canonicalGenerationArgs({ a: 1, z: [undefined, { zero: -0, n: Number.NaN }] }),
  'nested object keys must be recursively canonical regardless of insertion order',
);
assert.notEqual(canonicalGenerationArgs([undefined]), canonicalGenerationArgs([null]));
assert.notEqual(canonicalGenerationArgs({ value: 1 }), canonicalGenerationArgs({ value: '1' }));
assert.notEqual(canonicalGenerationArgs({ value: -0 }), canonicalGenerationArgs({ value: 0 }));

resetJobRegistryMemory();

function contextFor(projectId: string, getState: AgentContext['getState']): AgentContext {
  return {
    getState,
    getDoc: () => ({}) as never,
    getCreativeMode: () => null,
    getProjectId: () => projectId,
    commands: {} as never,
    templates: [],
    audio: [],
  };
}

const emptyState = { assets: [], items: [], fps: 30 } as never;
const context = contextFor('project-retry', () => emptyState);
const originalFetch = globalThis.fetch;
let providerCalls = 0;
const attemptsByPrompt = new Map<string, number>();
const operationIdsByPrompt = new Map<string, string[]>();
const acceptedOperationIdsByPrompt = new Map<string, Set<string>>();
globalThis.fetch = (async (_input, init) => {
  providerCalls += 1;
  const body = JSON.parse(String(init?.body)) as { operationId: string; prompt?: string };
  const prompt = body.prompt ?? '';
  const attempt = (attemptsByPrompt.get(prompt) ?? 0) + 1;
  attemptsByPrompt.set(prompt, attempt);
  operationIdsByPrompt.set(prompt, [...(operationIdsByPrompt.get(prompt) ?? []), body.operationId]);

  if (prompt === 'idempotency failed then retry check' && attempt === 1) {
    return new Response(JSON.stringify({ error: 'provider rejected invalid request' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (prompt === 'temporary 503 then retry' && attempt === 1) {
    return new Response('', { status: 503 });
  }

  const acceptedIds = acceptedOperationIdsByPrompt.get(prompt) ?? new Set<string>();
  acceptedIds.add(body.operationId);
  acceptedOperationIdsByPrompt.set(prompt, acceptedIds);
  if ((prompt === 'response lost then retry' || prompt === 'reload response lost') && attempt === 1) {
    throw new TypeError('network response lost after provider acceptance');
  }

  return new Response(JSON.stringify({
    operationId: body.operationId,
    jobId: body.operationId,
    status: 'queued',
    provider: 'mureka',
    providerTaskId: `provider-${providerCalls}`,
    acceptedAt: Date.now(),
  }), { status: 202, headers: { 'Content-Type': 'application/json' } });
}) as typeof fetch;

const request = {
  provider: 'mureka',
  mode: 'instrumental',
  prompt: 'idempotency failed then retry check',
  name: 'Retry check',
  nested: { second: [2, undefined], first: { enabled: true } },
};
try {
  const failed = await execGenerateTool('submit_music', request, context) as { error?: string };
  assert.match(failed.error ?? '', /provider rejected/);
  const accepted = await execGenerateTool('submit_music', {
    ...request,
    nested: { first: { enabled: true }, second: [2, undefined] },
  }, context) as { status?: string };
  assert.equal(accepted.status, 'queued', 'a synchronous provider error must not occupy the duplicate window');
  assert.equal(providerCalls, 2);
  const terminalAttemptIds = operationIdsByPrompt.get(request.prompt) ?? [];
  assert.equal(terminalAttemptIds.length, 2);
  assert.notEqual(
    terminalAttemptIds[0],
    terminalAttemptIds[1],
    'a definitive provider rejection releases the reservation so a later request gets a new operation id',
  );

  const duplicate = await execGenerateTool('submit_music', request, context) as { code?: string };
  assert.equal(duplicate.code, 'duplicate_submission');
  assert.equal(providerCalls, 2, 'an accepted identical request must not reach the provider twice');

  const explicitRerun = await execGenerateTool('submit_music', { ...request, __rerunGeneration: true }, context) as { status?: string };
  assert.equal(explicitRerun.status, 'queued');
  assert.equal(providerCalls, 3, 'an explicitly confirmed rerun bypasses the ordinary idempotency window');
  const rerunAttemptIds = operationIdsByPrompt.get(request.prompt) ?? [];
  assert.notEqual(
    rerunAttemptIds[1],
    rerunAttemptIds[2],
    'an explicit rerun creates a new operation id instead of resuming the accepted operation',
  );

  const responseLostRequest = {
    provider: 'mureka',
    mode: 'instrumental',
    prompt: 'response lost then retry',
    name: 'Response loss',
  };
  const responseLostContext = contextFor('project-response-loss', () => emptyState);
  const responseLost = await execGenerateTool('submit_music', responseLostRequest, responseLostContext) as {
    status?: string;
    resumable?: boolean;
    operationId?: string;
  };
  assert.equal(responseLost.status, 'pending');
  assert.equal(responseLost.resumable, true, 'unknown acceptance is resumable rather than an accepted duplicate');
  const recoveredResponse = await execGenerateTool('submit_music', responseLostRequest, responseLostContext) as {
    status?: string;
    operationId?: string;
  };
  assert.equal(recoveredResponse.status, 'queued');
  assert.equal(recoveredResponse.operationId, responseLost.operationId);
  assert.deepEqual(
    operationIdsByPrompt.get(responseLostRequest.prompt),
    [responseLost.operationId, responseLost.operationId],
    'response-loss retry submits the exact same durable operation id',
  );
  assert.equal(
    acceptedOperationIdsByPrompt.get(responseLostRequest.prompt)?.size,
    1,
    'the server observes one accepted operation across response loss and retry',
  );

  const temporaryRequest = {
    provider: 'mureka',
    mode: 'instrumental',
    prompt: 'temporary 503 then retry',
    name: 'Temporary provider error',
  };
  const temporaryContext = contextFor('project-temporary-error', () => emptyState);
  const temporaryPending = await execGenerateTool('submit_music', temporaryRequest, temporaryContext) as {
    status?: string;
    operationId?: string;
  };
  assert.equal(temporaryPending.status, 'pending');
  const temporaryAccepted = await execGenerateTool('submit_music', temporaryRequest, temporaryContext) as {
    status?: string;
    operationId?: string;
  };
  assert.equal(temporaryAccepted.status, 'queued');
  assert.equal(temporaryAccepted.operationId, temporaryPending.operationId, '5xx retries retain the operation id');

  const reloadRequest = {
    provider: 'mureka',
    mode: 'instrumental',
    prompt: 'reload response lost',
    name: 'Reload recovery',
  };
  const reloadContext = contextFor('project-reload-recovery', () => emptyState);
  const beforeReload = await execGenerateTool('submit_music', reloadRequest, reloadContext) as {
    status?: string;
    operationId?: string;
  };
  assert.equal(beforeReload.status, 'pending');
  resetGenerationIdempotencyMemory();
  const afterReload = await execGenerateTool('submit_music', reloadRequest, reloadContext) as {
    status?: string;
    operationId?: string;
  };
  assert.equal(afterReload.status, 'queued');
  assert.equal(afterReload.operationId, beforeReload.operationId, 'reload restores the durable semantic reservation');
  resetGenerationIdempotencyMemory();
  const reloadDuplicate = await execGenerateTool('submit_music', reloadRequest, reloadContext) as {
    code?: string;
    duplicateOf?: string;
  };
  assert.equal(reloadDuplicate.code, 'duplicate_submission');
  assert.equal(reloadDuplicate.duplicateOf, beforeReload.operationId, 'durable accepted state preserves the 60s duplicate guard');

  const crossProjectRequest = {
    provider: 'mureka',
    mode: 'instrumental',
    prompt: 'same request in two projects',
    name: 'Project boundary',
  };
  const projectA = contextFor('project-a', () => emptyState);
  const projectB = contextFor('project-b', () => emptyState);
  const crossProjectCalls = providerCalls;
  const firstProjectAccepted = await execGenerateTool('submit_music', crossProjectRequest, projectA) as { status?: string };
  assert.equal(firstProjectAccepted.status, 'queued');
  const firstProjectDuplicate = await execGenerateTool('submit_music', crossProjectRequest, projectA) as { code?: string };
  assert.equal(firstProjectDuplicate.code, 'duplicate_submission');
  const secondProjectAccepted = await execGenerateTool('submit_music', crossProjectRequest, projectB) as { status?: string };
  assert.equal(secondProjectAccepted.status, 'queued', 'the same request in a different project is a new submission');
  assert.equal(providerCalls, crossProjectCalls + 2);

  let sourceAsset = {
    id: 'asset-source',
    name: 'Source',
    kind: 'video',
    src: '/media/uploads/source-a.mp4',
    sourceRevision: 'source-revision-a',
    durationInFrames: 300,
  };
  const sourceContext = contextFor('project-relink', () => ({
    assets: [sourceAsset],
    items: [],
    fps: 30,
  }) as never);
  const sourceRequest = {
    provider: 'mureka',
    mode: 'soundtrack',
    prompt: 'score this source',
    sourceAssetId: 'asset-source',
    name: 'Relink boundary',
  };
  const relinkCalls = providerCalls;
  const sourceAccepted = await execGenerateTool('submit_music', sourceRequest, sourceContext) as { status?: string };
  assert.equal(sourceAccepted.status, 'queued');
  const sourceDuplicate = await execGenerateTool('submit_music', sourceRequest, sourceContext) as { code?: string };
  assert.equal(sourceDuplicate.code, 'duplicate_submission', 'same project and source revision remains duplicate');
  sourceAsset = {
    ...sourceAsset,
    src: '/media/uploads/source-b.mp4',
    sourceRevision: 'source-revision-b',
  };
  const relinkAccepted = await execGenerateTool('submit_music', sourceRequest, sourceContext) as { status?: string };
  assert.equal(relinkAccepted.status, 'queued', 'relinking the same asset id creates a new semantic request');
  assert.equal(providerCalls, relinkCalls + 2);

  const missingContext = contextFor('project-missing-source', () => ({
    assets: [],
    items: [],
    fps: 30,
  }) as never);
  const missingRequest = { ...sourceRequest, sourceAssetId: 'missing-asset' };
  const missingCalls = providerCalls;
  const missingFirst = await execGenerateTool('submit_music', missingRequest, missingContext) as { error?: string; code?: string };
  assert.match(missingFirst.error ?? '', /music source asset not found/);
  assert.notEqual(missingFirst.code, 'duplicate_submission');
  const missingSecond = await execGenerateTool('submit_music', missingRequest, missingContext) as { error?: string; code?: string };
  assert.match(missingSecond.error ?? '', /music source asset not found/);
  assert.notEqual(missingSecond.code, 'duplicate_submission', 'failed reference resolution is never remembered as accepted');
  assert.equal(providerCalls, missingCalls, 'a missing source keeps the existing preflight error before provider submission');

  const referenceState = {
    assets: [
      { id: 'image-a', name: 'Image A', kind: 'image', src: '/media/uploads/a.png', sourceRevision: 'image-a-r1', durationInFrames: 1 },
      { id: 'image-b', name: 'Image B', kind: 'image', src: '/media/uploads/b.png', sourceRevision: 'image-b-r1', durationInFrames: 1 },
      { id: 'video-a', name: 'Video A', kind: 'video', src: '/media/uploads/video-a.mp4', sourceRevision: 'video-a-r1', durationInFrames: 120 },
    ],
    items: [
      {
        id: 'clip-a',
        name: 'Clip A',
        kind: 'video',
        track: 'video-1',
        startFrame: 0,
        durationInFrames: 60,
        src: '/media/uploads/video-a.mp4',
        sourceRevision: 'clip-a-r1',
      },
    ],
    fps: 30,
  };
  const referenceContext = contextFor('project-reference-order', () => referenceState as never);
  const orderedKey = generationIdempotencyKey('submit_video', {
    model: 'seedance2',
    firstFrame: 'image-a',
    refImages: ['image-a', 'image-b'],
  }, referenceContext);
  const reorderedPropertiesKey = generationIdempotencyKey('submit_video', {
    refImages: ['image-a', 'image-b'],
    firstFrame: 'image-a',
    model: 'seedance2',
  }, referenceContext);
  assert.equal(orderedKey, reorderedPropertiesKey, 'object property insertion order is canonical');
  assert.notEqual(
    orderedKey,
    generationIdempotencyKey('submit_video', {
      model: 'seedance2',
      firstFrame: 'image-a',
      refImages: ['image-b', 'image-a'],
    }, referenceContext),
    'reference arrays preserve semantic provider order rather than sorting IDs',
  );

  const timelineKey = generationIdempotencyKey('submit_video', {
    model: 'seedance2',
    refVideos: ['clip-a'],
  }, referenceContext);
  referenceState.items[0].src = '/media/uploads/video-b.mp4';
  referenceState.items[0].sourceRevision = 'clip-a-r2';
  assert.notEqual(
    timelineKey,
    generationIdempotencyKey('submit_video', { model: 'seedance2', refVideos: ['clip-a'] }, referenceContext),
    'timeline item references include the current clip source identity',
  );

  assert.notEqual(
    generationIdempotencyKey('submit_music', crossProjectRequest, projectA),
    generationIdempotencyKey('submit_music', crossProjectRequest, projectB),
    'project id is part of the canonical key',
  );
  assert.equal(
    generationIdempotencyKey('submit_music', { ...crossProjectRequest, providerToken: 'secret-a' }, projectA),
    generationIdempotencyKey('submit_music', { ...crossProjectRequest, providerToken: 'secret-b' }, projectA),
    'non-schema provider credentials are not included in the public semantic key',
  );
  const inlineBytesKey = generationIdempotencyKey('submit_video', {
    model: 'seedance2',
    firstFrame: 'data:image/png;base64,private-source-bytes',
  }, referenceContext);
  assert.doesNotMatch(inlineBytesKey, /private-source-bytes/, 'inline source bytes are omitted from the key');
} finally {
  globalThis.fetch = originalFetch;
}

console.log('generation semantic idempotency and rerun checks passed');
