import assert from 'node:assert/strict';
import { expectedMusicResultCount, validateMusicRequest } from './music.ts';
import {
  SONILO_MUSIC_MAX_VIDEO_SECONDS,
  SONILO_SFX_MAX_VIDEO_SECONDS,
  pickSoniloTracks,
  soniloTaskId,
} from './sonilo-media.ts';

// ── request validation ──
const promptless = validateMusicRequest({
  provider: 'sonilo', sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video',
});
assert.equal(promptless.provider, 'sonilo');
assert.equal(promptless.mode, 'v2m', 'sonilo infers v2m without an explicit mode');
assert.equal(promptless.prompt, '', 'sonilo v2m works promptless');
assert.equal(promptless.count, 1);
assert.equal(promptless.isInstrumental, true);
assert.equal(expectedMusicResultCount(promptless), 1, 'sonilo returns exactly one result');

const styled = validateMusicRequest({
  provider: 'sonilo', mode: 'v2m', sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video',
  prompt: 'warm indie folk, no drums', name: 'Score · final cut',
});
assert.equal(styled.prompt, 'warm indie folk, no drums');
assert.equal(styled.name, 'Score · final cut');

assert.throws(() => validateMusicRequest({ provider: 'sonilo' }), /video sourceAssetId/);
assert.throws(
  () => validateMusicRequest({ provider: 'sonilo', sourceAssetPath: '/media/uploads/a.png', sourceAssetKind: 'image' }),
  /video sourceAssetId/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'sonilo', mode: 'soundtrack', sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video' }),
  /mode must be v2m/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'sonilo', sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video', prompt: 'x'.repeat(501),
  }),
  /at most 500/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'sonilo', sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video', lyrics: 'hello',
  }),
  /does not take lyrics/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'sonilo', sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video', styles: ['pop'],
  }),
  /mureka provider only/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'sonilo', sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video', bitrate: 128_000,
  }),
  /not supported by sonilo/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'sonilo', sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video', count: 2,
  }),
  /count must be 1/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'sonilo', sourceAssetPath: '/media/uploads/cut.mp4', sourceAssetKind: 'video', audioFormat: 'mp3',
  }),
  /not configurable/,
);
// sonilo controls must not leak into the other providers
assert.throws(() => validateMusicRequest({ provider: 'minimax', prompt: 'lofi', mode: 'v2m' }), /t2m or cover/);
assert.throws(() => validateMusicRequest({ provider: 'mureka', mode: 'v2m', prompt: 'lofi' }), /mureka mode must be/);
assert.throws(() => validateMusicRequest({ provider: 'suno', prompt: 'lofi' }), /mureka, minimax, or sonilo/);

// ── task shapes ──
assert.equal(soniloTaskId({ task_id: 'task-1' }), 'task-1');
assert.equal(soniloTaskId({ id: 'task-2' }), 'task-2');
assert.equal(soniloTaskId({}), undefined);

const singleTrack = pickSoniloTracks({
  status: 'succeeded',
  result: { audio: { url: 'https://cdn.example/a.m4a', license_id: 'lic-a' } },
});
assert.deepEqual(singleTrack, [{ name: 'audio', url: 'https://cdn.example/a.m4a', licenseId: 'lic-a' }]);

const multiTrack = pickSoniloTracks({
  status: 'succeeded',
  tracks: [
    { name: 'main', url: 'https://cdn.example/main.m4a', license_id: 'lic-main' },
    { audio_url: 'https://cdn.example/alt.m4a' },
    { name: 'broken' },
  ],
});
assert.equal(multiTrack.length, 2, 'entries without a URL are skipped');
assert.equal(multiTrack[0].name, 'main', 'primary track stays first');
assert.equal(multiTrack[0].licenseId, 'lic-main');
assert.equal(multiTrack[1].url, 'https://cdn.example/alt.m4a');
assert.equal(multiTrack[1].licenseId, undefined, 'missing license_id stays undefined');

const keyedResult = pickSoniloTracks({
  status: 'succeeded',
  result: {
    audio: { url: 'https://cdn.example/a.m4a', license_id: 'lic-a' },
    stems: [{ url: 'https://cdn.example/b.m4a', license_id: 'lic-b' }],
    meta: 'not-a-track',
  },
});
assert.equal(keyedResult.length, 2);
assert.deepEqual(keyedResult[1], { name: 'stems_1', url: 'https://cdn.example/b.m4a', licenseId: 'lic-b' });

assert.deepEqual(pickSoniloTracks({ status: 'succeeded' }), [], 'empty result yields no tracks');

// ── documented caps ──
assert.equal(SONILO_MUSIC_MAX_VIDEO_SECONDS, 360, 'music cap is a 6-minute video');
assert.equal(SONILO_SFX_MAX_VIDEO_SECONDS, 180, 'SFX cap is a 3-minute video');

console.log('music-sonilo.check: ok (v2m validation + task track/license extraction)');
