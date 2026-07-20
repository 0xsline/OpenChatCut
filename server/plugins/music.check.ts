import assert from 'node:assert/strict';
import { isMinimaxCoverModel, pickMurekaAudioUrl, validateMusicRequest } from './music.ts';

assert.equal(pickMurekaAudioUrl({ choices: [{ audio_url: 'a' }] }), 'a');
assert.equal(pickMurekaAudioUrl({ choices: [{ url: 'u' }] }), 'u');

const mureka = validateMusicRequest({ prompt: 'calm piano bed' });
assert.equal(mureka.provider, 'mureka');
assert.equal(mureka.isInstrumental, true);

const mmInst = validateMusicRequest({ provider: 'minimax', prompt: 'lofi chill' });
assert.equal(mmInst.isInstrumental, true);
assert.equal(mmInst.lyricsOptimizer, false);

const mmLyrics = validateMusicRequest({
  provider: 'minimax',
  prompt: 'indie folk',
  lyrics: '[Verse]\nhello',
});
assert.equal(mmLyrics.isInstrumental, false);
assert.equal(mmLyrics.lyrics, '[Verse]\nhello');

const mmAuto = validateMusicRequest({
  provider: 'minimax',
  prompt: 'rainy night pop',
  lyricsOptimizer: true,
});
assert.equal(mmAuto.isInstrumental, false);
assert.equal(mmAuto.lyricsOptimizer, true);

const mmAudio = validateMusicRequest({
  provider: 'minimax',
  prompt: 'orchestral',
  sampleRate: 32_000,
  bitrate: 128_000,
  audioFormat: 'wav',
});
assert.equal(mmAudio.sampleRate, 32_000);
assert.equal(mmAudio.audioFormat, 'wav');

// minimax prompt can be longer than 1024
validateMusicRequest({ provider: 'minimax', prompt: 'x'.repeat(1500) });

assert.throws(
  () => validateMusicRequest({ provider: 'mureka', prompt: 'x', lyrics: 'hi' }),
  /lyrics are only supported by the minimax/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x', isInstrumental: false }),
  /require lyrics/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x', lyrics: 'hi', isInstrumental: true }),
  /cannot be combined with lyrics/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x', sampleRate: 48_000 }),
  /sampleRate must be/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'mureka', prompt: 'x', bitrate: 128_000 }),
  /supported by minimax only/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x'.repeat(2001) }),
  /at most 2000/,
);

// music-cover
assert.equal(isMinimaxCoverModel('music-cover'), true);
assert.equal(isMinimaxCoverModel('music-cover-free'), true);
assert.equal(isMinimaxCoverModel('music-2.6'), false);

const cover = validateMusicRequest({
  provider: 'minimax',
  prompt: 'Jazz piano cover, soft and intimate',
  referenceAudioPath: '/media/uploads/source.mp3',
});
assert.equal(cover.coverMode, true);
assert.equal(cover.referenceAudioPath, '/media/uploads/source.mp3');

assert.throws(
  () => validateMusicRequest({
    provider: 'minimax',
    prompt: 'short',
    referenceAudioPath: '/media/uploads/source.mp3',
  }),
  /at least 10 characters/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'mureka',
    prompt: 'Jazz piano cover style',
    referenceAudioPath: '/media/uploads/source.mp3',
  }),
  /music-cover only/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'minimax',
    prompt: 'Jazz piano cover, soft and intimate',
    referenceAudioPath: '/media/uploads/source.mp3',
    isInstrumental: true,
  }),
  /not used for music-cover/,
);

console.log('music.check: ok (minimax t2m + music-cover)');
