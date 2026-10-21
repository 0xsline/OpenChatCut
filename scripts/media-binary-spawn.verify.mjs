// Media-binary invariant: application code starts ffmpeg and ffprobe through
// server/media-binaries.ts (ffmpegBin() / ffprobeBin()), never by bare command name.
//
// The packaged app ships its own ffmpeg (ffmpeg-static) and ffprobe (@ffprobe-installer).
// A bare `spawn('ffprobe', …)` skips both and searches the user's PATH instead, which
// rarely holds a system ffmpeg; a macOS app opened from Finder or the Dock inherits only
// /usr/bin:/bin:/usr/sbin:/sbin. Generated voice, sound, music and video all failed with
// `spawn ffprobe ENOENT` that way, after the paid provider call had already succeeded.
// CI installs a system ffmpeg, so no functional verify can see this; a source scan can.
//
// Scope: the file set of the 500-line ceiling in verify-gate-coverage.verify.mjs, i.e.
// tracked and nonignored untracked sources minus verify/test files, which run on CI
// machines that install ffmpeg on purpose. Handing "ffprobe" to a runner that resolves
// its own binary (remotion/aac-encoder-delay.mjs passes it to RenderInternals.callFf)
// is not a process spawn and is not matched.
//
// No allowlist, for the reason verify-gate-coverage.verify.mjs gives: an excused call
// site would be invisible in exactly the way these were.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A spawn/exec-family call whose program is the literal "ffmpeg" or "ffprobe": the argv
// form `spawn('ffprobe', [...])` and the shell form `execSync('ffmpeg -i …')`. The callee
// pattern covers node:child_process, promisified aliases (execFileAsync) and the repo's
// own wrapper (spawnMediaProcess).
const BARE_MEDIA_SPAWN = /\b[\w$]*(?:spawn|exec)[\w$]*\s*\(\s*(['"`])(?:ffmpeg|ffprobe)(?:\.exe)?(?:\1|\s)/gi;

const bareSpawns = (source) => [...source.matchAll(BARE_MEDIA_SPAWN)]
  .map((match) => source.slice(0, match.index).split('\n').length);

// Guard the guard: a pattern that stopped matching would pass while asserting nothing.
for (const bad of [
  "spawn('ffprobe', ['-v', 'error', file])",
  'spawnSync("ffmpeg", args)',
  'spawnMediaProcess(`ffmpeg`, [...ffmpegThreadArgs(), ...args])',
  "execFileAsync('ffprobe.exe', args)",
  "execSync('ffmpeg -i in.mp4 out.wav')",
  "spawn(\n  'ffprobe',\n  args,\n)",
]) assert.equal(bareSpawns(bad).length, 1, `the scan must flag: ${bad}`);
for (const good of [
  "spawn(ffprobeBin(), ['-v', 'error', file])",
  'spawnMediaProcess(ffmpegBin(), args)',
  "await run('ffprobe', ['-v', 'error', file])",
  "reject(new Error('ffprobe exited 1'))",
  "const ALLOWED = new Set(['ffmpeg', 'ffprobe'])",
]) assert.deepEqual(bareSpawns(good), [], `the scan must not flag: ${good}`);

const sourceFiles = [...new Set(execFileSync('git', [
  'ls-files', '--cached', '--others', '--exclude-standard', '-z',
], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].filter((file) => (
  /\.(?:tsx|mts|cjs|mjs|ts|js)$/.test(file)
  && !/\.(?:verify|check|test|spec)(?:[.-])|\.d\.ts$/.test(file)
  && existsSync(join(root, file))
));
assert.ok(sourceFiles.length > 1000, `expected the full source tree, found ${sourceFiles.length} files`);
assert.ok(sourceFiles.includes('server/media-binaries.ts'), 'the scan must cover server/');

const offenders = sourceFiles.flatMap((file) => (
  bareSpawns(readFileSync(join(root, file), 'utf8')).map((line) => `${file}:${line}`)
)).sort();
assert.deepEqual(offenders, [],
  'Start ffmpeg/ffprobe with ffmpegBin()/ffprobeBin() from server/media-binaries.ts, '
  + `not by bare command name (packaged installs have no ffmpeg on PATH):\n${offenders.map((at) => `  - ${at}`).join('\n')}`);

console.log(`media binary spawn check passed (${sourceFiles.length} source files, no bare ffmpeg/ffprobe spawns)`);
