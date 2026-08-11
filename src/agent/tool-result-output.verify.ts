import assert from 'node:assert/strict';
import { toolResultModelOutput } from './tool-result-output.ts';

assert.deepEqual(
  toolResultModelOutput({ denied: true, note: 'Denied by user.' }),
  { type: 'execution-denied', reason: 'Denied by user.' },
);
const imageOutput = toolResultModelOutput({
  __images: [{ frame: 12, base64: 'aGVsbG8=' }],
  frames: [12],
});
assert.equal(imageOutput.type, 'content');
if (imageOutput.type !== 'content') throw new Error('expected content output');
assert.equal(imageOutput.value[0]?.type, 'file');
assert.equal(imageOutput.value[1]?.type, 'text');

const malformed = toolResultModelOutput({
  __images: [{ frame: 'not-a-frame', base64: 12 }],
  ok: true,
});
assert.equal(malformed.type, 'text', 'malformed image metadata never reaches the provider as a file');
const projectedBinaryPlaceholder = toolResultModelOutput({
  __images: [{ frame: 1, base64: '[binary payload omitted]' }],
  imagesOmitted: true,
});
assert.equal(projectedBinaryPlaceholder.type, 'text',
  'sanitized binary placeholders are never emitted as provider image files');


const exact = { contents: { 'SKILL.md': 'exact skill body' } };
assert.deepEqual(
  toolResultModelOutput(exact, true),
  { type: 'text', value: JSON.stringify(exact) },
  'load_skill output remains exact',
);

console.log('tool-result-output.verify: denied, image, malformed, and exact outputs OK');
