import assert from 'node:assert/strict';
import {
  transcribePathResumable,
  type AssemblyAiProviderStatus,
  type AssemblyAiResumeCheckpoint,
} from './assemblyai';
import {
  loadTranscriptionCheckpoint,
  resetTranscriptionCheckpointQueues,
  saveTranscriptionCheckpoint,
  type TranscriptionCheckpoint,
  type TranscriptionProviderStatus,
} from '../persist/transcriptionJobStore';
import { resetSharedKvMemory } from '../persist/sharedKv';
import {
  __resetTranscribeJobs,
  enqueueTranscription,
  getTranscribeJob,
  untranscribedTimelineItemIdsForRevision,
} from './transcribe-jobs';
import type { TranscriptWord } from './types';

const originalFetch = globalThis.fetch;
const projectId = 'project-asr-verify';
const providerStatus = (status: AssemblyAiProviderStatus | undefined): TranscriptionProviderStatus => {
  if (status === 'uploaded') return 'uploaded';
  if (status === 'submitted') return 'submitted';
  if (status === 'completed') return 'completed';
  if (status === 'error') return 'failed';
  return 'processing';
};

async function waitUntil(assertion: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (assertion()) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  assert.fail(message);
}

try {
  resetSharedKvMemory();
  resetTranscriptionCheckpointQueues();
  const key = { projectId, assetId: 'asset-resume', sourceRevision: 'rev-resume' };
  let uploadCount = 0;
  let createCount = 0;
  let pollCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/assemblyai-upload') {
      uploadCount += 1;
      assert.equal(JSON.parse(String(init?.body)).src, '/media/uploads/asr.wav');
      return Response.json({ uploadUrl: 'https://assembly.example/upload/once', bytes: 5 });
    }
    if (url.endsWith('/transcript') && init?.method === 'POST') {
      createCount += 1;
      return Response.json({ id: 'provider-job-1' });
    }
    if (url.endsWith('/transcript/provider-job-1')) {
      pollCount += 1;
      if (pollCount === 1) throw new TypeError('refresh interrupted polling');
      return Response.json({
        status: 'completed',
        text: '恢复成功',
        words: [{ text: '恢复成功', start: 0, end: 500 }],
        utterances: [],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const createdAt = Date.now();
  const writer = async (provider: AssemblyAiResumeCheckpoint) => {
    const previous = await loadTranscriptionCheckpoint(key);
    const checkpoint: TranscriptionCheckpoint = {
      projectId: key.projectId,
      assetId: key.assetId,
      sourceRevision: key.sourceRevision,
      provider: 'assemblyai',
      providerJobId: provider.providerJobId,
      providerStatus: providerStatus(provider.providerStatus),
      uploadUrl: provider.uploadUrl,
      languageCode: 'zh',
      retry: previous?.retry ?? { attempts: 1, lastAttemptAt: createdAt },
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: Date.now(),
    };
    await saveTranscriptionCheckpoint(checkpoint);
  };

  await assert.rejects(() => transcribePathResumable(
    '/media/uploads/master.mp4',
    {},
    writer,
    undefined,
    { asrPath: '/media/uploads/asr.wav', languageCode: 'zh' },
  ));
  const afterRefresh = await loadTranscriptionCheckpoint(key);
  assert.equal(afterRefresh?.providerJobId, 'provider-job-1', 'provider id is durable before the first poll');
  assert.equal(afterRefresh?.uploadUrl, 'https://assembly.example/upload/once');

  const resumed = await transcribePathResumable(
    '/media/uploads/master.mp4',
    {
      uploadUrl: afterRefresh?.uploadUrl,
      providerJobId: afterRefresh?.providerJobId,
      providerStatus: 'submitted',
    },
    writer,
    undefined,
    { languageCode: 'zh' },
  );
  assert.equal(resumed.words[0]?.text, '恢复成功');
  assert.equal(uploadCount, 1, 'refresh resume never uploads the same source twice');
  assert.equal(createCount, 1, 'refresh resume never creates a second provider job');

  resetSharedKvMemory();
  resetTranscriptionCheckpointQueues();
  __resetTranscribeJobs();
  let completedCallbacks = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/assemblyai-upload') {
      assert.equal(JSON.parse(String(init?.body)).src, '/media/uploads/stale-asr.wav');
      return Response.json({ uploadUrl: 'https://assembly.example/upload/stale', bytes: 5 });
    }
    if (url.endsWith('/transcript') && init?.method === 'POST') return Response.json({ id: 'provider-job-stale' });
    if (url.endsWith('/transcript/provider-job-stale')) return Response.json({
      status: 'completed', text: 'old bytes', words: [{ text: 'old', start: 0, end: 200 }], utterances: [],
    });
    throw new Error(`unexpected fetch ${url}`);
  };
  enqueueTranscription(projectId, {
    id: 'asset-stale',
    src: '/media/uploads/stale.mp4',
    sourceRevision: 'rev-old',
  }, {
    asrPath: '/media/uploads/stale-asr.wav',
    getCurrentAsset: () => ({
      id: 'asset-stale', src: '/media/uploads/relinked.mp4', sourceRevision: 'rev-new',
    }),
    onComplete: () => { completedCallbacks += 1; },
  });
  for (let attempt = 0; attempt < 20 && getTranscribeJob(projectId, 'asset-stale')?.status === 'running'; attempt += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  const stale = getTranscribeJob(projectId, 'asset-stale');
  assert.equal(stale?.stale, true, 'late ASR results fail the source-revision commit guard');
  assert.equal(stale?.words, undefined);
  assert.equal(completedCallbacks, 0, 'a stale result never reaches the project writer');

  resetSharedKvMemory();
  resetTranscriptionCheckpointQueues();
  __resetTranscribeJobs();
  let liveUploadCount = 0;
  let liveCreateCount = 0;
  let liveCompleteCount = 0;
  let readyCompleteCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/assemblyai-upload') {
      liveUploadCount += 1;
      assert.equal(JSON.parse(String(init?.body)).src, '/media/uploads/live-asr.wav');
      return Response.json({ uploadUrl: `https://assembly.example/upload/live-${liveUploadCount}`, bytes: 5 });
    }
    if (url.endsWith('/transcript') && init?.method === 'POST') {
      liveCreateCount += 1;
      return Response.json({ id: `provider-job-live-${liveCreateCount}` });
    }
    if (url.endsWith('/transcript/provider-job-live-1')) return Response.json({
      status: 'completed',
      text: 'authoritative-a',
      words: [{ text: 'authoritative-a', start: 0, end: 300 }],
      utterances: [],
    });
    if (url.endsWith('/transcript/provider-job-live-2')) return Response.json({
      status: 'completed',
      text: 'authoritative-b',
      words: [{ text: 'authoritative-b', start: 0, end: 300 }],
      utterances: [],
    });
    throw new Error(`unexpected fetch ${url}`);
  };
  enqueueTranscription(projectId, {
    id: 'asset-live',
    src: '/media/uploads/live-master.mp4',
    kind: 'video',
    name: 'live.mp4',
    sourceRevision: 'rev-authoritative',
  }, {
    asrPath: '/media/uploads/live-asr.wav',
    onComplete: () => { liveCompleteCount += 1; },
  });
  enqueueTranscription(projectId, {
    id: 'asset-live',
    src: '/media/uploads/live-normalized.mp4',
    kind: 'video',
    name: 'live.mp4',
    sourceRevision: 'rev-authoritative',
  }, {
    onComplete: () => { readyCompleteCount += 1; },
  });
  await waitUntil(
    () => getTranscribeJob(projectId, 'asset-live')?.status === 'done',
    'live progressive transcription did not complete',
  );
  assert.equal(getTranscribeJob(projectId, 'asset-live')?.sourceRevision, 'rev-authoritative');
  assert.equal(liveUploadCount, 1, 'live progressive import uploads ASR bytes once');
  assert.equal(liveCreateCount, 1, 'live progressive import submits one provider job');
  assert.equal(liveCompleteCount, 1, 'the uploaded descriptor owns the terminal callback');
  assert.equal(readyCompleteCount, 0, 'the ready descriptor cannot publish a duplicate terminal callback');

  const isolatedProjectId = 'project-asr-isolated';
  enqueueTranscription(isolatedProjectId, {
    id: 'asset-live',
    src: '/media/uploads/live-master.mp4',
    kind: 'video',
    name: 'live.mp4',
    sourceRevision: 'rev-authoritative',
  }, {
    asrPath: '/media/uploads/live-asr.wav',
  });
  await waitUntil(
    () => getTranscribeJob(isolatedProjectId, 'asset-live')?.status === 'done',
    'same source identity in another project did not run independently',
  );
  assert.equal(getTranscribeJob(projectId, 'asset-live')?.words?.[0]?.text, 'authoritative-a');
  assert.equal(getTranscribeJob(isolatedProjectId, 'asset-live')?.words?.[0]?.text, 'authoritative-b');
  const projectACheckpoint = await loadTranscriptionCheckpoint({
    projectId,
    assetId: 'asset-live',
    sourceRevision: 'rev-authoritative',
  });
  const projectBCheckpoint = await loadTranscriptionCheckpoint({
    projectId: isolatedProjectId,
    assetId: 'asset-live',
    sourceRevision: 'rev-authoritative',
  });
  assert.notEqual(projectACheckpoint?.uploadUrl, projectBCheckpoint?.uploadUrl);
  assert.notEqual(projectACheckpoint?.providerJobId, projectBCheckpoint?.providerJobId);
  assert.equal(liveUploadCount, 2, 'same source identity uploads independently across projects');
  assert.equal(liveCreateCount, 2, 'same source identity submits independently across projects');

  resetSharedKvMemory();
  resetTranscriptionCheckpointQueues();
  __resetTranscribeJobs();
  const reloadKey = { projectId, assetId: 'asset-reload', sourceRevision: 'rev-reload' };
  const reloadCreatedAt = Date.now();
  await saveTranscriptionCheckpoint({
    ...reloadKey,
    provider: 'assemblyai',
    providerJobId: 'provider-job-reload',
    providerStatus: 'processing',
    uploadUrl: 'https://assembly.example/upload/reload',
    languageCode: 'zh',
    retry: { attempts: 1, lastAttemptAt: reloadCreatedAt },
    createdAt: reloadCreatedAt,
    updatedAt: reloadCreatedAt,
  });
  let reloadUploadCount = 0;
  let reloadCreateCount = 0;
  let reloadPollCount = 0;
  let reloadCompleteCount = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/assemblyai-upload') {
      reloadUploadCount += 1;
      return Response.json({ uploadUrl: 'https://assembly.example/upload/unexpected', bytes: 5 });
    }
    if (url.endsWith('/transcript') && init?.method === 'POST') {
      reloadCreateCount += 1;
      return Response.json({ id: 'provider-job-unexpected' });
    }
    if (url.endsWith('/transcript/provider-job-reload')) {
      reloadPollCount += 1;
      return Response.json({
        status: 'completed',
        text: 'reload',
        words: [{ text: 'reload', start: 0, end: 200 }],
        utterances: [],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const reloadAsset = {
    id: reloadKey.assetId,
    src: '/media/uploads/reload.mp4',
    kind: 'video' as const,
    sourceRevision: reloadKey.sourceRevision,
  };
  enqueueTranscription(projectId, reloadAsset, {
    onComplete: () => { reloadCompleteCount += 1; },
  });
  enqueueTranscription(projectId, reloadAsset, {
    onComplete: () => { reloadCompleteCount += 1; },
  });
  await waitUntil(
    () => getTranscribeJob(projectId, reloadKey.assetId)?.status === 'done',
    'persisted running transcription did not resume',
  );
  assert.equal(reloadUploadCount, 0, 'reload uses the persisted provider upload');
  assert.equal(reloadCreateCount, 0, 'reload does not submit another provider job');
  assert.equal(reloadPollCount, 1, 'persisted running job resumes once');
  assert.equal(reloadCompleteCount, 1, 'deduplicated reload publishes one terminal result');

  resetSharedKvMemory();
  resetTranscriptionCheckpointQueues();
  __resetTranscribeJobs();
  let generationUploadCount = 0;
  let oldPollStarted = false;
  let oldPollReturned = false;
  let resolveOldPoll: ((response: Response) => void) | undefined;
  const oldPoll = new Promise<Response>((resolve) => {
    resolveOldPoll = resolve;
  });
  const publishedRevisions: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === '/api/assemblyai-upload') {
      generationUploadCount += 1;
      const src = JSON.parse(String(init?.body)).src as string;
      const generation = src.includes('generation-old') ? 'old' : 'new';
      return Response.json({
        uploadUrl: `https://assembly.example/upload/generation-${generation}`,
        bytes: 5,
      });
    }
    if (url.endsWith('/transcript') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}')) as { audio_url?: string };
      return Response.json({
        id: body.audio_url?.endsWith('old') ? 'provider-job-generation-old' : 'provider-job-generation-new',
      });
    }
    if (url.endsWith('/transcript/provider-job-generation-old')) {
      oldPollStarted = true;
      const response = await oldPoll;
      oldPollReturned = true;
      return response;
    }
    if (url.endsWith('/transcript/provider-job-generation-new')) return Response.json({
      status: 'completed',
      text: 'new generation',
      words: [{ text: 'new', start: 0, end: 200 }],
      utterances: [],
    });
    throw new Error(`unexpected fetch ${url}`);
  };
  enqueueTranscription(projectId, {
    id: 'asset-generation',
    src: '/media/uploads/generation-old.mp4',
    sourceRevision: 'rev-generation-old',
  }, {
    asrPath: '/media/uploads/generation-old.wav',
    onComplete: (job) => { publishedRevisions.push(job.sourceRevision); },
  });
  await waitUntil(() => oldPollStarted, 'old generation never reached provider polling');
  const oldGeneration = getTranscribeJob(projectId, 'asset-generation')?.generation;
  enqueueTranscription(projectId, {
    id: 'asset-generation',
    src: '/media/uploads/generation-new.mp4',
    sourceRevision: 'rev-generation-new',
  }, {
    asrPath: '/media/uploads/generation-new.wav',
    onComplete: (job) => { publishedRevisions.push(job.sourceRevision); },
  });
  await waitUntil(
    () => getTranscribeJob(projectId, 'asset-generation')?.status === 'done',
    'new generation did not complete',
  );
  const currentGeneration = getTranscribeJob(projectId, 'asset-generation');
  assert.ok((currentGeneration?.generation ?? 0) > (oldGeneration ?? 0));
  assert.equal(currentGeneration?.sourceRevision, 'rev-generation-new');
  assert.equal(currentGeneration?.words?.[0]?.text, 'new');
  if (!resolveOldPoll) assert.fail('old generation poll resolver was not installed');
  resolveOldPoll(Response.json({
    status: 'completed',
    text: 'old generation',
    words: [{ text: 'old', start: 0, end: 200 }],
    utterances: [],
  }));
  await waitUntil(() => oldPollReturned, 'old generation terminal response did not return');
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  const afterLateTerminal = getTranscribeJob(projectId, 'asset-generation');
  assert.equal(afterLateTerminal?.generation, currentGeneration?.generation);
  assert.equal(afterLateTerminal?.sourceRevision, 'rev-generation-new');
  assert.equal(afterLateTerminal?.words?.[0]?.text, 'new');
  assert.deepEqual(publishedRevisions, ['rev-generation-new'], 'old generation cannot publish onComplete');
  const oldGenerationCheckpoint = await loadTranscriptionCheckpoint({
    projectId,
    assetId: 'asset-generation',
    sourceRevision: 'rev-generation-old',
  });
  assert.equal(oldGenerationCheckpoint?.providerJobId, 'provider-job-generation-old');
  assert.notEqual(oldGenerationCheckpoint?.providerStatus, 'completed', 'old generation cannot write terminal state');

  let sameNameItems: {
    id: string;
    name: string;
    sourceRevision: string;
    transcript?: TranscriptWord[];
    transcriptStale?: boolean;
  }[] = [
    { id: 'clip-camera-a', name: 'C0001.MP4', sourceRevision: 'rev-camera-a' },
    { id: 'clip-camera-b', name: 'C0001.MP4', sourceRevision: 'rev-camera-b' },
    { id: 'clip-camera-a-stale', name: 'C0001.MP4', sourceRevision: 'rev-camera-a', transcript: [{ text: 'old stale', start: 0, end: 100 }], transcriptStale: true },
    { id: 'clip-camera-a-fresh', name: 'C0001.MP4', sourceRevision: 'rev-camera-a', transcript: [{ text: 'keep fresh', start: 0, end: 100 }] },
  ];
  await Promise.all([
    { sourceRevision: 'rev-camera-a', words: [{ text: 'camera a', start: 0, end: 100 }] },
    { sourceRevision: 'rev-camera-b', words: [{ text: 'camera b', start: 0, end: 100 }] },
  ].map(async (completion) => {
    await Promise.resolve();
    const targets = new Set(untranscribedTimelineItemIdsForRevision(
      sameNameItems,
      completion.sourceRevision,
    ));
    sameNameItems = sameNameItems.map((item) => (
      targets.has(item.id) ? { ...item, transcript: completion.words, transcriptStale: false } : item
    ));
  }));
  assert.equal(sameNameItems[0]?.name, sameNameItems[1]?.name);
  assert.equal(sameNameItems[0]?.transcript?.[0]?.text, 'camera a');
  assert.equal(sameNameItems[1]?.transcript?.[0]?.text, 'camera b');
  assert.equal(sameNameItems[2]?.transcript?.[0]?.text, 'camera a', 'current-revision ASR replaces retained stale transcript');
  assert.equal(sameNameItems[2]?.transcriptStale, false);
  assert.equal(sameNameItems[3]?.transcript?.[0]?.text, 'keep fresh', 'fresh current transcript is not redundantly overwritten');
  assert.deepEqual(
    untranscribedTimelineItemIdsForRevision(sameNameItems, 'rev-camera-a', true),
    ['clip-camera-a', 'clip-camera-a-stale', 'clip-camera-a-fresh'],
    'an explicit retry replaces every timeline copy for the current source revision',
  );
} finally {
  globalThis.fetch = originalFetch;
  __resetTranscribeJobs();
  resetSharedKvMemory();
  resetTranscriptionCheckpointQueues();
}

console.log('assemblyai-resume.verify: ok');
