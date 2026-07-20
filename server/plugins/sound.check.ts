import assert from 'node:assert/strict';
import { validateSoundRequest } from './sound.ts';

const ok = validateSoundRequest({ prompt: 'short whoosh' });
assert.equal(ok.durationSeconds, 4);
assert.equal(ok.promptInfluence, 0.3);

const custom = validateSoundRequest({ prompt: 'thunder', durationSeconds: 8, promptInfluence: 0.8 });
assert.equal(custom.durationSeconds, 8);

assert.throws(() => validateSoundRequest({ prompt: '' }), /prompt is required/);
assert.throws(() => validateSoundRequest({ prompt: 'x', durationSeconds: 0.1 }), /durationSeconds must be between/);
assert.throws(() => validateSoundRequest({ prompt: 'x', promptInfluence: 2 }), /promptInfluence must be between/);

console.log('sound.check: ok (elevenlabs sound-generation bounds)');
