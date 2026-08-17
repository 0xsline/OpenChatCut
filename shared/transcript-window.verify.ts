import assert from 'node:assert/strict';
import { isTranscriptWindowPayload, type TranscriptWindowPayload } from './transcript-window';

const valid: TranscriptWindowPayload = {
  entries: [
    { id: 'a1', name: '访谈一', transcript: [{ text: '你好', start: 0, end: 200 }] },
    { id: 'a2', name: '访谈二', transcript: [] },
  ],
  index: 1,
};
assert.equal(isTranscriptWindowPayload(valid), true, 'valid payload passes');

assert.equal(isTranscriptWindowPayload(null), false, 'null rejected');
assert.equal(isTranscriptWindowPayload('x'), false, 'string rejected');
assert.equal(isTranscriptWindowPayload({ entries: [], index: 0 }), true, 'empty entries allowed');
assert.equal(isTranscriptWindowPayload({ entries: [], index: -1 }), false, 'negative index rejected');
assert.equal(isTranscriptWindowPayload({ entries: [], index: 1.5 }), false, 'fractional index rejected');
assert.equal(isTranscriptWindowPayload({ entries: [], index: NaN }), false, 'NaN index rejected');
assert.equal(
  isTranscriptWindowPayload({ entries: [{ id: '', name: 'x', transcript: [] }], index: 0 }),
  false,
  'empty id rejected',
);
assert.equal(
  isTranscriptWindowPayload({ entries: [{ id: 'a', name: 'x', transcript: [{ text: 't', start: 0, end: 'bad' }] }], index: 0 }),
  false,
  'non-numeric word end rejected',
);
assert.equal(
  isTranscriptWindowPayload({ entries: [{ id: 'a', name: 'x', transcript: [{ text: 7, start: 0, end: 1 }] }], index: 0 }),
  false,
  'non-string word text rejected',
);
assert.equal(
  isTranscriptWindowPayload({ entries: [{ id: 'a', name: 42, transcript: [] }], index: 0 }),
  false,
  'non-string name rejected',
);

console.log('transcript-window.verify: payload boundary validation passed');
