// Generated voice lands through the bundled ffmpeg/ffprobe, never the user's PATH.
//
// Packaged installs rarely have a system ffmpeg, and a macOS app opened from Finder or
// the Dock inherits only /usr/bin:/bin:/usr/sbin:/sbin. saveVoiceAudio used to spawn
// ffprobe by bare name, so every TTS result failed with `spawn ffprobe ENOENT` after the
// provider had already billed the request. scripts/media-binary-spawn.verify.mjs keeps
// the bare spawns out statically; this proves the landing works with an empty PATH.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'occ-voice-media-'));
const emptyPath = await mkdtemp(join(tmpdir(), 'occ-empty-path-'));
const saved = {
  path: process.env.PATH,
  dataDir: process.env.OPENCHATCUT_DATA_DIR,
  profileId: process.env.OPENCHATCUT_DEV_PROFILE_ID,
};
process.env.OPENCHATCUT_DATA_DIR = root;
process.env.OPENCHATCUT_DEV_PROFILE_ID = 'b44abc36-d2cb-4b67-bbb2-f9c82a608ff6';

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

try {
  const { ffmpegBin } = await import('../media-binaries.ts');
  const { isSafeUploadName } = await import('../media-dir.ts');
  const { saveVoiceAudio } = await import('./voice-media.ts');

  // One second of tone, shaped like a provider's mp3 and like raw 16-bit mono PCM.
  const tone = (format: string): Buffer => {
    const made = spawnSync(ffmpegBin(), [
      '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ar', '24000', '-ac', '1', '-f', format, 'pipe:1',
    ], { maxBuffer: 16 * 1024 * 1024 });
    assert.equal(made.status, 0, `fixture encode failed: ${String(made.stderr)}`);
    return made.stdout;
  };
  const mp3 = tone('mp3');
  const pcm = tone('s16le');

  // Nothing named ffmpeg or ffprobe is reachable through PATH from here on.
  process.env.PATH = emptyPath;
  const cases = [
    { label: 'mp3 (ffprobe)', bytes: mp3, codec: 'mp3', pitch: 0 },
    { label: 'raw pcm (ffmpeg wrap, ffprobe)', bytes: pcm, codec: 'pcm', pitch: 0 },
    { label: 'pitch shift (ffmpeg filter, ffprobe)', bytes: mp3, codec: 'mp3', pitch: 2 },
  ];
  for (const { label, bytes, codec, pitch } of cases) {
    const result = await saveVoiceAudio(bytes, codec, 24_000, pitch);
    assert.ok(Math.abs(result.durationSeconds - 1) < 0.15, `${label}: probed ${result.durationSeconds}s`);
    assert.ok(result.path.startsWith('/media/uploads/'), `${label}: ${result.path}`);
    const name = result.path.slice('/media/uploads/'.length);
    assert.ok(isSafeUploadName(name), `${label}: the upload route must accept the returned name ${name}`);
    assert.ok((await stat(join(root, 'media', 'uploads', name))).size > 0, `${label}: landed file is empty`);
  }
} finally {
  restore('PATH', saved.path);
  restore('OPENCHATCUT_DATA_DIR', saved.dataDir);
  restore('OPENCHATCUT_DEV_PROFILE_ID', saved.profileId);
  await rm(root, { recursive: true, force: true });
  await rm(emptyPath, { recursive: true, force: true });
}

console.log('voice media landing verification passed (bundled ffmpeg/ffprobe, empty PATH)');
