import assert from 'node:assert/strict';
import { validateSoundRequest } from './sound.ts';

const ok = validateSoundRequest({ prompt: 'short whoosh' });
assert.equal(ok.durationSeconds, undefined);
assert.equal(ok.promptInfluence, 0.3);
assert.equal(ok.loop, false);
assert.equal(ok.outputFormat, 'mp3_44100_128');

const custom = validateSoundRequest({ prompt: 'thunder', durationSeconds: 30, promptInfluence: 0.8, loop: true, outputFormat: 'opus_48000_128' });
assert.equal(custom.durationSeconds, 30);
assert.equal(custom.loop, true);

assert.throws(() => validateSoundRequest({ prompt: '' }), /prompt is required/);
assert.throws(() => validateSoundRequest({ prompt: 'x', durationSeconds: 0.1 }), /durationSeconds must be between/);
assert.throws(() => validateSoundRequest({ prompt: 'x', promptInfluence: 2 }), /promptInfluence must be between/);
assert.throws(() => validateSoundRequest({ prompt: 'x', outputFormat: 'wav' }), /unsupported ElevenLabs outputFormat/);

console.log('sound.check: ok (elevenlabs official sound parameters)');
