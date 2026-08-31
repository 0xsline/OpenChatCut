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
import { findExecutable, flattenExecutableDir } from './sync-whisper-cli.mjs';

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

console.log('sync-whisper-cli.verify: the executable keeps its DLLs / shared objects');
