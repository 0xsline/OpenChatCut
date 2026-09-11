// The desktop native-ASR worker spawns whisper-cli with no cwd, so the binary
// has to find its own libraries — Windows searches the executable's directory
// for DLLs first, and the Linux builds carry an $ORIGIN RUNPATH. Flattening
// only the executable out of the archive's nested directory therefore shipped a
// binary that could not start: a windows-latest runner exits 127 on
// `whisper-cli.exe --help`. That is issue #120 — Windows local transcription was
// never slow, it never ran.
// node scripts/sync-whisper-cli.verify.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  adoptable,
  archiveProblem,
  findExecutable,
  flattenExecutableDir,
  helpProbeProblem,
  MIN_WHISPER_BINARY_BYTES,
  PLATFORMS,
  provisionedProblem,
  VERSION,
} from './sync-whisper-cli.mjs';

const scratch = await mkdtemp(join(tmpdir(), 'whisper-flatten-'));
const tree = async (root, files) => {
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body);
  }
  return root;
};

try {
  // ── the real Windows layout: whisper-bin-x64.zip nests under Release/ ──────
  {
    const target = await mkdtemp(join(scratch, 'win-'));
    await tree(target, {
      'Release/whisper-cli.exe': 'exe',
      'Release/ggml.dll': 'dll',
      'Release/ggml-base.dll': 'dll',
      'Release/ggml-cpu-haswell.dll': 'dll',
      'Release/whisper.dll': 'dll',
      'Release/SDL2.dll': 'dll',
    });

    const bin = await flattenExecutableDir(target, 'whisper-cli.exe');
    assert.equal(bin, join(target, 'whisper-cli.exe'));

    const beside = await readdir(target);
    for (const dll of ['ggml.dll', 'ggml-base.dll', 'ggml-cpu-haswell.dll', 'whisper.dll', 'SDL2.dll']) {
      assert.ok(beside.includes(dll),
        `${dll} must land beside the executable — Windows resolves DLLs from the exe's own directory`);
    }
    assert.ok(!beside.includes('Release'), 'the nested directory is consumed, not left behind');
  }

  // ── the Linux tarball: whisper-bin-ubuntu-x64/ with shared objects ─────────
  {
    const target = await mkdtemp(join(scratch, 'linux-'));
    await tree(target, {
      'whisper-bin-ubuntu-x64/whisper-cli': 'elf',
      'whisper-bin-ubuntu-x64/libwhisper.so.1': 'so',
      'whisper-bin-ubuntu-x64/libggml.so': 'so',
      'whisper-bin-ubuntu-x64/libggml-cpu.so': 'so',
    });

    await flattenExecutableDir(target, 'whisper-cli');

    const beside = await readdir(target);
    for (const so of ['libwhisper.so.1', 'libggml.so', 'libggml-cpu.so']) {
      assert.ok(beside.includes(so),
        `${so} must land beside the executable — the binary finds it through an $ORIGIN RUNPATH`);
    }
  }

  // ── the search backtracks across sibling directories ───────────────────────
  {
    // `return walk(first)` gave up on every later sibling, so an archive whose
    // listing puts any other directory first reported "not found".
    const target = await mkdtemp(join(scratch, 'siblings-'));
    await tree(target, {
      'aaa-docs/README.md': 'docs',
      'aaa-docs/models/tiny.bin': 'model',
      'zzz-Release/whisper-cli': 'elf',
      'zzz-Release/libggml.so': 'so',
    });

    const found = await findExecutable(target, 'whisper-cli');
    assert.ok(found, 'a directory listed before the executable\'s must not end the search');
    assert.equal(found, join(target, 'zzz-Release', 'whisper-cli'));
  }

  // ── already flat: a no-op that keeps everything ────────────────────────────
  {
    const target = await mkdtemp(join(scratch, 'flat-'));
    await tree(target, { 'whisper-cli': 'elf', 'libggml.so': 'so' });
    await flattenExecutableDir(target, 'whisper-cli');
    assert.deepEqual((await readdir(target)).sort(), ['libggml.so', 'whisper-cli']);
  }

  // ── a missing executable is an error, not a silently empty directory ───────
  {
    const target = await mkdtemp(join(scratch, 'empty-'));
    await tree(target, { 'Release/ggml.dll': 'dll' });
    await assert.rejects(
      () => flattenExecutableDir(target, 'whisper-cli.exe'),
      /not found/,
      'shipping a directory with no executable must fail the provisioning step',
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

// ── the pinned release digests must stay complete across a VERSION bump ──────
for (const [platform, spec] of Object.entries(PLATFORMS)) {
  if (!spec.asset) {
    assert.equal(spec.archiveSha256, undefined, `${platform} builds from source and pins no archive`);
    continue;
  }
  assert.match(spec.archiveSha256 ?? '', /^[0-9a-f]{64}$/, `${platform} pins a sha256 for ${spec.asset}`);
  assert.ok(spec.archiveBytes > 1_000_000, `${platform} pins the archive size for ${spec.asset}`);
}
assert.match(VERSION, /^v\d+\.\d+\.\d+$/);

// ── an archive is judged before anything is written ──────────────────────────
{
  const bytes = new Uint8Array(2_000_000).fill(7);
  const digest = createHash('sha256').update(bytes).digest('hex');
  const spec = { archiveBytes: bytes.length, archiveSha256: digest };
  assert.equal(archiveProblem(bytes, spec), null, 'the pinned archive is accepted');
  assert.match(
    archiveProblem(bytes.subarray(0, 1_000), spec) ?? '',
    /1000 bytes, pinned size is 2000000/,
    'a truncated download is rejected on size',
  );
  assert.match(
    archiveProblem(new Uint8Array(bytes.length).fill(8), spec) ?? '',
    /does not match the pinned/,
    'a same-size but different archive is rejected on digest',
  );
}

// ── `--help` has to actually run; exiting 0 is not enough ────────────────────
{
  const banner = `usage: whisper-cli [options] file0 file1 ...\n${'-'.repeat(400)}`;
  assert.equal(helpProbeProblem(0, banner), null);
  assert.match(helpProbeProblem(127, '') ?? '', /exited 127/, 'a binary that cannot find its libraries is rejected');
  assert.match(helpProbeProblem('ENOENT', '') ?? '', /exited ENOENT/);
  assert.match(
    helpProbeProblem(0, '') ?? '',
    /printed no usable output/,
    'a placeholder that merely exits 0 is rejected',
  );
  assert.match(helpProbeProblem(0, 'x'.repeat(400)) ?? '', /not a whisper usage banner/);
}

// ── the skip path is a verification, not existsSync() ────────────────────────
{
  const expected = { version: 'v1.9.2', archiveSha256: 'a'.repeat(64) };
  const record = {
    version: 'v1.9.2',
    source: 'asset',
    archiveSha256: 'a'.repeat(64),
    binarySha256: 'b'.repeat(64),
  };
  const binary = { bytes: 830_792, executable: true, sha256: 'b'.repeat(64) };
  const good = { expected, record, binary, probe: { problem: null } };

  assert.equal(provisionedProblem(good), null, 'a verified binary is reused');
  assert.match(
    provisionedProblem({ ...good, record: null }) ?? '',
    /no provenance record/,
    'a binary installed before provenance existed is re-provisioned',
  );
  assert.match(
    provisionedProblem({ ...good, record: { ...record, version: 'v1.8.0' } }) ?? '',
    /provisioned from v1\.8\.0, want v1\.9\.2/,
    'a stale upstream version is re-provisioned',
  );
  assert.match(
    provisionedProblem({ ...good, record: { ...record, archiveSha256: 'c'.repeat(64) } }) ?? '',
    /archive digest does not match/,
    'a binary from a different archive than the pinned one is re-provisioned',
  );
  assert.match(provisionedProblem({ ...good, binary: null }) ?? '', /binary is missing/);
  assert.match(
    provisionedProblem({ ...good, binary: { bytes: 17, executable: true, sha256: 'b'.repeat(64) } }) ?? '',
    /only 17 bytes/,
    'the 17-byte "#!/bin/sh; exit 0" placeholder never survives',
  );
  assert.match(
    provisionedProblem({ ...good, binary: { ...binary, executable: false } }) ?? '',
    /not executable/,
  );
  assert.match(
    provisionedProblem({ ...good, binary: { ...binary, sha256: 'd'.repeat(64) } }) ?? '',
    /does not match its provenance digest/,
    'bytes replaced after provisioning are caught',
  );
  assert.match(
    provisionedProblem({ ...good, probe: { problem: '`--help` exited 127' } }) ?? '',
    /exited 127/,
    'a probe failure re-provisions even when the digests line up',
  );

  // An explicitly supplied binary has no knowable upstream version, but it is
  // still held to the digest, size, executable-bit and probe checks.
  const override = { ...record, source: 'override', version: undefined, archiveSha256: null };
  assert.equal(provisionedProblem({ ...good, record: override }), null);
  assert.match(
    provisionedProblem({ ...good, record: override, binary: { bytes: 17, executable: true, sha256: 'b'.repeat(64) } }) ?? '',
    /only 17 bytes/,
  );
}

// ── adopting a pre-provenance binary, but only one that actually runs ────────
{
  const working = { bytes: 830_792, executable: true, sha256: 'b'.repeat(64) };
  assert.equal(adoptable({ binary: working, probe: { problem: null } }), true);
  assert.equal(adoptable({ binary: null, probe: null }), false, 'nothing to adopt');
  assert.equal(
    adoptable({ binary: { ...working, bytes: 17 }, probe: { problem: null } }),
    false,
    'the placeholder exits 0 but is far below the size floor',
  );
  assert.equal(adoptable({ binary: { ...working, executable: false }, probe: { problem: null } }), false);
  assert.equal(
    adoptable({ binary: working, probe: { problem: '`--help` exited 127' } }),
    false,
    'a binary that cannot start is never adopted',
  );
  assert.equal(
    adoptable({ binary: { ...working, bytes: MIN_WHISPER_BINARY_BYTES }, probe: { problem: null } }),
    true,
    'the floor is inclusive',
  );
}

console.log('sync-whisper-cli.verify: layout keeps its libraries, and provisioning verifies instead of trusting existsSync');
