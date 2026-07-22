import assert from 'node:assert/strict';
import { isMinimaxCoverModel, pickMurekaAudioUrl, validateMusicRequest } from './music.ts';
import { murekaRequestShape } from './music-mureka.ts';

assert.equal(pickMurekaAudioUrl({ choices: [{ audio_url: 'a' }] }), 'a');
assert.equal(pickMurekaAudioUrl({ choices: [{ url: 'u' }] }), 'u');

const mureka = validateMusicRequest({ prompt: 'calm piano bed' });
assert.equal(mureka.provider, 'mureka');
assert.equal(mureka.isInstrumental, true);
assert.equal(mureka.mode, 'instrumental');

const murekaSong = validateMusicRequest({
  provider: 'mureka', mode: 'song', lyrics: '[Verse]\nhello', prompt: 'indie folk', gender: 'female', count: 3,
});
assert.equal(murekaSong.count, 3);
assert.equal(murekaSong.gender, 'female');
assert.equal(murekaRequestShape(murekaSong, 'auto').endpoint, '/v1/song/generate');

const promptSong = validateMusicRequest({ provider: 'mureka', mode: 'prompt-song', styles: ['pop', 'j-pop'] });
assert.deepEqual(promptSong.styles, ['pop', 'j-pop']);
assert.equal(murekaRequestShape(promptSong, 'auto').endpoint, '/v1/song/easy-generate');

const soundtrack = validateMusicRequest({
  provider: 'mureka', mode: 'soundtrack', sourceAssetPath: '/media/uploads/shot.mp4',
  sourceAssetKind: 'video', audioStartMs: 1_000, audioEndMs: 4_000,
});
assert.equal(soundtrack.mode, 'soundtrack');
const soundtrackRequest = murekaRequestShape(soundtrack, 'auto', 'uploaded-video');
assert.equal(soundtrackRequest.endpoint, '/v1/soundtrack/generate');
assert.equal(soundtrackRequest.body.video_id, 'uploaded-video');

const track = validateMusicRequest({
  provider: 'mureka', mode: 'track', songId: 'song-1', trackType: 'Vocals',
  prompt: 'warm lead vocal', vocalGender: 'male', lyrics: 'hello',
});
assert.equal(track.trackType, 'Vocals');
assert.equal(murekaRequestShape(track, 'auto').endpoint, '/v1/track/generate');
assert.equal(murekaRequestShape(mureka, 'auto').endpoint, '/v1/instrumental/generate');

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

assert.throws(() => validateMusicRequest({ provider: 'mureka', mode: 'song', prompt: 'x' }), /requires lyrics/);
assert.throws(
  () => validateMusicRequest({ provider: 'mureka', mode: 'soundtrack', sourceAssetPath: '/media/uploads/a.mp3', sourceAssetKind: 'audio' }),
  /image or video/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'mureka', mode: 'track', songId: 's', trackType: 'Drums', prompt: 'drums', vocalGender: 'male' }),
  /Vocals trackType only/,
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
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x', stream: true }),
  /Mureka generation controls/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'mureka', prompt: 'x', bitrate: 128_000 }),
  /MiniMax-only controls/,
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
  /10–300 characters/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'mureka',
    prompt: 'Jazz piano cover style',
    referenceAudioPath: '/media/uploads/source.mp3',
  }),
  /MiniMax-only controls/,
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

const coverFeature = validateMusicRequest({
  provider: 'minimax', mode: 'cover', prompt: 'Warm acoustic cover with close vocals',
  coverFeatureId: 'feature-1', lyrics: 'ten letters or more',
});
assert.equal(coverFeature.coverFeatureId, 'feature-1');

console.log('music.check: ok (all Mureka modes + MiniMax t2m/cover)');
