import assert from 'node:assert/strict';
import {
  __resetTranscribeJobs,
  enqueueTranscription,
  getTranscribeJob,
  resetTranscribeJobs,
} from './transcribe-jobs';

const originalFetch = globalThis.fetch;
let createRequests = 0;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url === '/api/assemblyai-upload') {
    return new Response(JSON.stringify({ uploadUrl: 'https://upload.example/test', bytes: 32 }), { status: 200 });
  }
  if (url === '/assemblyai/v2/transcript' && init?.method === 'POST') {
    createRequests += 1;
    return new Response(JSON.stringify({ id: `job-${createRequests}` }), { status: 200 });
  }
  if (url.startsWith('/assemblyai/v2/transcript/job-')) {
    return new Response(JSON.stringify({
      status: 'completed',
      text: 'hello',
      words: [{ text: 'hello', start: 0, end: 100 }],
    }), { status: 200 });
  }
  throw new Error(`unexpected fetch ${url}`);
};

async function waitForTerminal(assetId: string): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    if (getTranscribeJob(assetId)?.status === 'done') return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`job ${assetId} did not complete`);
}

try {
  const retriedAsset = { id: 'asset-retry', src: '/media/uploads/test.wav' };
  const untouchedAsset = { id: 'asset-untouched', src: '/media/uploads/other.wav' };

  enqueueTranscription(retriedAsset);
  enqueueTranscription(untouchedAsset);
  await waitForTerminal(retriedAsset.id);
  await waitForTerminal(untouchedAsset.id);
  assert.equal(createRequests, 2);

  resetTranscribeJobs([retriedAsset.id]);
  assert.equal(getTranscribeJob(retriedAsset.id), undefined);
  assert.equal(getTranscribeJob(untouchedAsset.id)?.status, 'done');

  enqueueTranscription(retriedAsset);
  await waitForTerminal(retriedAsset.id);
  assert.equal(createRequests, 3, 'clearing a transcript must allow a new ASR job');
} finally {
  globalThis.fetch = originalFetch;
  __resetTranscribeJobs();
}

console.log('transcribe-jobs.verify: ok');
