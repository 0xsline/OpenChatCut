// FFMPEG_PATH is a convention shared with other tools and often holds a directory.
// On Windows the app copied that directory as ffmpeg.exe and died at startup with
// `EPERM ... copyfile` (issue #262). An override must now resolve to a real file:
// a file is used, a directory resolves to the platform binary inside it, and
// anything else names the variable and what to set instead.
// npx tsx server/media-binaries-override.verify.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegBin, ffprobeBin, resolveBinaryOverride } from './media-binaries.ts';

const root = mkdtempSync(join(tmpdir(), 'media-binaries-override-'));
const app = (name: string) => (process.platform === 'win32' ? `${name}.exe` : name);
const saved = Object.fromEntries(
  ['OPENCHATCUT_FFMPEG', 'FFMPEG_PATH', 'OPENCHATCUT_FFPROBE', 'FFPROBE_PATH']
    .map((key) => [key, process.env[key]]),
);

try {
  // (a) A file is accepted as-is, for the app-specific and the generic variable.
  const file = join(root, 'ffmpeg-file');
  writeFileSync(file, 'binary');
  assert.equal(resolveBinaryOverride(file, 'OPENCHATCUT_FFMPEG', 'OPENCHATCUT_FFMPEG', 'ffmpeg'), file);
  assert.equal(resolveBinaryOverride(file, 'FFMPEG_PATH', 'OPENCHATCUT_FFMPEG', 'ffmpeg'), file);

  // (b) The common `C:\ffmpeg\bin` convention: a directory that holds the binary is
  // resolved to the file, with the executable name of the target platform.
  const binDirectory = join(root, 'bin');
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(join(binDirectory, 'ffmpeg.exe'), 'binary');
  writeFileSync(join(binDirectory, 'ffmpeg'), 'binary');
  assert.equal(
    resolveBinaryOverride(binDirectory, 'FFMPEG_PATH', 'OPENCHATCUT_FFMPEG', 'ffmpeg', { platform: 'win32' }),
    join(binDirectory, 'ffmpeg.exe'),
    'a win32 directory resolves to ffmpeg.exe, not the POSIX name',
  );
  assert.equal(
    resolveBinaryOverride(binDirectory, 'FFMPEG_PATH', 'OPENCHATCUT_FFMPEG', 'ffmpeg', { platform: 'linux' }),
    join(binDirectory, 'ffmpeg'),
    'a POSIX directory resolves to ffmpeg',
  );
  // The same resolution through the public resolver, on the host platform.
  const hostBinary = join(binDirectory, app('ffmpeg'));
  process.env.FFMPEG_PATH = binDirectory;
  assert.equal(ffmpegBin(), hostBinary, 'ffmpegBin() uses the executable inside a directory override');
  delete process.env.FFMPEG_PATH;

  // (c) A directory without the executable is a named, actionable rejection, not EPERM.
  const emptyDirectory = join(root, 'no-binary');
  mkdirSync(emptyDirectory);
  for (const platform of ['win32', 'linux'] as const) {
    const nested = join(emptyDirectory, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    assert.throws(
      () => resolveBinaryOverride(emptyDirectory, 'FFMPEG_PATH', 'OPENCHATCUT_FFMPEG', 'ffmpeg', { platform }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^FFMPEG_PATH points at a directory that contains no ffmpeg executable: /);
        assert.ok(error.message.includes(emptyDirectory), 'the message names the offending path');
        assert.ok(error.message.includes(nested), `the message names the executable to set (${nested})`);
        assert.match(error.message, /OPENCHATCUT_FFMPEG/, 'the message names the override to use instead');
        return true;
      },
    );
  }
  // A path that does not exist at all is rejected the same way.
  assert.throws(
    () => resolveBinaryOverride(join(root, 'missing-ffmpeg'), 'OPENCHATCUT_FFMPEG', 'OPENCHATCUT_FFMPEG', 'ffmpeg'),
    /OPENCHATCUT_FFMPEG does not point at an executable file: /,
  );
  // ffprobe has the same convention, so it gets the same guard.
  assert.throws(
    () => resolveBinaryOverride(emptyDirectory, 'FFPROBE_PATH', 'OPENCHATCUT_FFPROBE', 'ffprobe'),
    /FFPROBE_PATH points at a directory that contains no ffprobe executable: /,
  );

  // The app-specific variable wins over the generic one, and it is validated first:
  // a broken OPENCHATCUT_FFMPEG must not silently fall through to a good FFMPEG_PATH.
  process.env.FFMPEG_PATH = emptyDirectory;
  process.env.OPENCHATCUT_FFMPEG = file;
  assert.equal(ffmpegBin(), file, 'OPENCHATCUT_FFMPEG wins over FFMPEG_PATH');
  process.env.OPENCHATCUT_FFMPEG = join(root, 'missing-app-ffmpeg');
  assert.throws(() => ffmpegBin(), /OPENCHATCUT_FFMPEG does not point at an executable file: /);
  delete process.env.OPENCHATCUT_FFMPEG;
  delete process.env.FFMPEG_PATH;

  // (d) No override: the existing chain still answers, and never throws.
  assert.doesNotThrow(() => ffmpegBin(), 'an unset override falls through to the bundled build');
  assert.doesNotThrow(() => ffprobeBin(), 'an unset override falls through to the bundled probe');
  assert.match(ffmpegBin(), /ffmpeg(?:\.exe)?$/, 'the bundled ffmpeg-static build is used');
  assert.match(ffprobeBin(), /ffprobe(?:\.exe)?$/, 'the bundled ffprobe is used');
  // A blank variable is unset, not an empty executable path.
  process.env.OPENCHATCUT_FFMPEG = '   ';
  assert.match(ffmpegBin(), /ffmpeg(?:\.exe)?$/, 'blank overrides fall through');
  delete process.env.OPENCHATCUT_FFMPEG;

  // (e) A bare command name is a PATH lookup, never a path: it is not stat'ed and
  // never rejected. The `'ffmpeg'` fallback in the chain relies on the same rule.
  const never = () => assert.fail('a bare command name must not touch the filesystem');
  for (const name of ['ffmpeg', 'ffprobe']) {
    assert.equal(
      resolveBinaryOverride(name, name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH', `OPENCHATCUT_${name.toUpperCase()}`, name, {
        platform: 'win32',
        exists: never,
        isFile: never,
      }),
      name,
      `${name} stays a PATH lookup`,
    );
  }
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

console.log('media-binaries-override.verify: file, directory and bare-command overrides resolve or reject by name');
