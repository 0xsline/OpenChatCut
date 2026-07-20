import assert from 'node:assert/strict';
import { validateVoiceRequest } from './voice.ts';

const mm = validateVoiceRequest({
  provider: 'minimax',
  text: '你好',
  voiceId: 'female-yujie',
  speed: 1.1,
  pitch: -2,
  volume: 1.5,
  emotion: 'calm',
});
assert.equal(mm.provider, 'minimax');
assert.equal(mm.pitch, -2);
assert.equal(mm.volume, 1.5);

assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', volume: 11 }),
  /volume must be between 0 and 10/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', pitch: 13 }),
  /pitch must be between -12 and 12/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'minimax', text: 'x', voiceId: 'a', emotion: 'calm', emotionScale: 2 }),
  /MiniMax accepts voiceId, speed, volume, pitch, and emotion only/,
);
assert.throws(
  () => validateVoiceRequest({ provider: 'elevenlabs', text: 'hi', voiceId: 'peter', volume: 2 }),
  /ElevenLabs does not accept/,
);

const doubao = validateVoiceRequest({
  provider: 'doubao',
  text: '你好',
  voiceId: 'vivi',
  pitch: 1,
  emotion: 'happy',
  emotionScale: 3,
});
assert.equal(doubao.provider, 'doubao');

console.log('voice.check: ok (minimax pitch/volume + provider gates)');
