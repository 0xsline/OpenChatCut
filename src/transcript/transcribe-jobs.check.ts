// Pure-logic check for the 上传即转写 job helpers: the transcribe-eligibility gate and
// the tool-facing status reconciliation. Run: tsx src/transcript/transcribe-jobs.check.ts
import assert from 'node:assert';
import { shouldTranscribe, transcriptionReport, type TranscribeJob } from './transcribe-jobs';

// ── shouldTranscribe: audio always; video unless told no audio; others never ──
assert.equal(shouldTranscribe('audio'), true, 'audio transcribes');
assert.equal(shouldTranscribe('audio', false), true, 'audio transcribes even if hasAudioTrack omitted/false-ish');
assert.equal(shouldTranscribe('video'), true, 'video transcribes by default');
assert.equal(shouldTranscribe('video', true), true, 'video with audio transcribes');
assert.equal(shouldTranscribe('video', false), false, 'video explicitly without audio does not transcribe');
assert.equal(shouldTranscribe('image'), false, 'image never transcribes');
assert.equal(shouldTranscribe('gif'), false, 'gif never transcribes');
assert.equal(shouldTranscribe('svg'), false, 'svg never transcribes');
assert.equal(shouldTranscribe('motion-graphic'), false, 'MG never transcribes');

// ── transcriptionReport: reconcile the live job with what's persisted on the asset ──
const done: TranscribeJob = { assetId: 'a1', status: 'done', words: [{ text: 'hi', start: 0, end: 100 }] };
assert.deepEqual(transcriptionReport('a1', done, 0), { assetId: 'a1', status: 'succeeded', wordCount: 1 }, 'done job → succeeded with job word count');

const failed: TranscribeJob = { assetId: 'a2', status: 'failed', error: 'boom' };
assert.deepEqual(transcriptionReport('a2', failed, 0), { assetId: 'a2', status: 'failed', error: 'boom' }, 'failed job → failed with error');

const running: TranscribeJob = { assetId: 'a3', status: 'running' };
assert.deepEqual(transcriptionReport('a3', running, 0), { assetId: 'a3', status: 'running' }, 'running job → running');

// No live job (e.g. after reload) but the asset already carries a transcript → succeeded.
assert.deepEqual(transcriptionReport('a4', undefined, 5), { assetId: 'a4', status: 'succeeded', wordCount: 5 }, 'persisted transcript, no job → succeeded');

// No job and nothing persisted → not_found (agent should (re)trigger ingest).
assert.deepEqual(transcriptionReport('a5', undefined, 0), { assetId: 'a5', status: 'not_found' }, 'no job, no transcript → not_found');

// A fresh done job is authoritative: 0 words means ASR found no speech (not "fall back
// to a stale asset count"). The ?? assetWordCount fallback only fires if words is absent.
const doneEmpty: TranscribeJob = { assetId: 'a6', status: 'done', words: [] };
assert.deepEqual(transcriptionReport('a6', doneEmpty, 3), { assetId: 'a6', status: 'succeeded', wordCount: 0 }, 'done job with 0 words → 0 (job is authoritative)');

console.log('transcribe-jobs.check.ts OK');
