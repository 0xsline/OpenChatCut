import assert from 'node:assert/strict';
import { shouldTranscribe, transcriptionReport, type TranscribeJob } from './transcribe-jobs';

assert.equal(shouldTranscribe('audio'), true);
assert.equal(shouldTranscribe('audio', false), true);
assert.equal(shouldTranscribe('video'), true);
assert.equal(shouldTranscribe('video', true), true);
assert.equal(shouldTranscribe('video', false), false);
assert.equal(shouldTranscribe('image'), false);
assert.equal(shouldTranscribe('gif'), false);
assert.equal(shouldTranscribe('svg'), false);
assert.equal(shouldTranscribe('motion-graphic'), false);

const job = (value: Omit<TranscribeJob, 'projectId' | 'generation' | 'sourceRevision'>): TranscribeJob => ({
  projectId: 'project',
  generation: 1,
  sourceRevision: 'revision',
  ...value,
});

const done = transcriptionReport('a1', job({
  assetId: 'a1',
  status: 'done',
  words: [{ text: 'hi', start: 0, end: 100 }],
}), 0);
assert.equal(done.status, 'succeeded');
assert.equal(done.wordCount, 1);
assert.equal(done.sourceRevision, 'revision');

const failed = transcriptionReport('a2', job({ assetId: 'a2', status: 'failed', error: 'boom' }), 0);
assert.equal(failed.status, 'failed');
assert.equal(failed.error, 'boom');

assert.equal(transcriptionReport('a3', job({ assetId: 'a3', status: 'running' }), 0).status, 'running');
assert.deepEqual(transcriptionReport('a4', undefined, 5), {
  assetId: 'a4',
  status: 'succeeded',
  wordCount: 5,
});
assert.deepEqual(transcriptionReport('a5', undefined, 0), {
  assetId: 'a5',
  status: 'not_found',
});

const doneEmpty = transcriptionReport('a6', job({ assetId: 'a6', status: 'done', words: [] }), 3);
assert.equal(doneEmpty.status, 'succeeded');
assert.equal(doneEmpty.wordCount, 0);

console.log('transcribe-jobs.verify: ok');
