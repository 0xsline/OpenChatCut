// Provision the whisper.cpp CLI binary used by the desktop native-ASR worker.
//
// Platform sources:
// - darwin-arm64 / darwin-x64: no official release asset exists; the build
//   machine compiles from source, or OPENCHATCUT_WHISPER_CLI supplies a
//   prebuilt binary.
// - win32-x64 / linux-x64 / linux-arm64: official GitHub release assets
//   (whisper-bin-*), checked against the size and sha256 pinned below BEFORE
//   anything is installed.
//
// Every provisioned binary gets a provenance record (<binary>.provenance.json)
// holding the upstream version, the pinned archive digest it came from, and the
// binary's own digest. A later run trusts an existing binary only when that
// record still matches the pinned expectations, the bytes still hash to the
// recorded digest, and `--help` actually runs. Previously the only check was
// existsSync(), so a truncated download or a placeholder file was installed
// permanently and then certified by a sha256 sidecar computed from those same
// bad bytes — a record nothing ever read.
//
// Output: public/whisper-cli/<platform>/whisper-cli[.exe]
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'public', 'whisper-cli');
const BUILD_CACHE = join(ROOT, '.cache', 'whisper-cli');
export const VERSION = 'v1.9.2';
const BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}`;

// Pinned from the GitHub release API for VERSION:
//   gh api repos/ggml-org/whisper.cpp/releases/tags/v1.9.2 \
//     --jq '.assets[] | select(.name|test("whisper-bin")) | "\(.name) \(.size) \(.digest)"'
// Regenerate both fields whenever VERSION moves. A mismatch must fail
// provisioning, never install whatever bytes arrived.
export const PLATFORMS = {
  'darwin-arm64': {
    asset: null,
    executable: 'whisper-cli',
    note: 'compile from source; OPENCHATCUT_WHISPER_CLI overrides',
  },
  // No official darwin-x64 release asset exists; compile from source (or run
  // the arm64 build under Rosetta where available).
  'darwin-x64': {
    asset: null,
    executable: 'whisper-cli',
    note: 'no official darwin-x64 asset; compile from source',
  },
  'win32-x64': {
    asset: 'whisper-bin-x64.zip',
    archiveBytes: 8_194_445,
    archiveSha256: '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a',
    executable: 'whisper-cli.exe',
  },
  'linux-x64': {
    asset: 'whisper-bin-ubuntu-x64.tar.gz',
    archiveBytes: 9_497_583,
    archiveSha256: '46811a3ecf584307480a220b9ef5ff81b7b22dc41577cbc274ce3afc61f753b1',
    executable: 'whisper-cli',
  },
  'linux-arm64': {
    asset: 'whisper-bin-ubuntu-arm64.tar.gz',
    archiveBytes: 4_572_842,
    archiveSha256: '7e26fa6a36d9174d5c0bf033ccbc026c3b5e569e2ee787058241346ef5392719',
    executable: 'whisper-cli',
  },
};

async function fetchArchive(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function extractArchive(archive, outDir) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  if (archive.endsWith('.zip')) {
    await run('unzip', ['-q', archive, '-d', outDir]);
  } else {
    await run('tar', ['-xzf', archive, '-C', outDir]);
  }
}

function sha256Of(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Any real whisper-cli build is ~0.8-1 MB; this only rejects stubs and truncations. */
export const MIN_WHISPER_BINARY_BYTES = 64 * 1024;
export const PROVENANCE_SUFFIX = '.provenance.json';
const LEGACY_DIGEST_SUFFIX = '.sha256';

/** Reject an archive before it is written anywhere. Pure. */
export function archiveProblem(bytes, spec) {
  if (bytes.length !== spec.archiveBytes) {
    return `archive is ${bytes.length} bytes, pinned size is ${spec.archiveBytes}`;
  }
  const digest = sha256Of(bytes);
  if (digest !== spec.archiveSha256) {
    return `archive sha256 ${digest} does not match the pinned ${spec.archiveSha256}`;
  }
  return null;
}

/**
 * `whisper-cli --help` needs no model and no audio: it only has to start. The
 * real banner goes to stderr and contains "usage:"; a missing DLL or shared
 * object exits non-zero (127 on the CI runners), and a placeholder script that
 * merely exits 0 prints nothing. Pure.
 */
export function helpProbeProblem(code, output) {
  if (code !== 0) return `\`--help\` exited ${code}`;
  if (output.length < 200) return '`--help` printed no usable output';
  if (!/usage:/i.test(output)) return '`--help` output is not a whisper usage banner';
  return null;
}

/**
 * Decide whether an already-provisioned binary can be trusted, so the skip path
 * is a verification instead of existsSync(). Pure; `binary` and `probe` are
 * null when the caller could not gather them.
 */
export function provisionedProblem({ expected, record, binary, probe }) {
  if (!record) return 'no provenance record';
  if (record.source === 'override' || record.source === 'adopted') {
    // A binary supplied by hand, or adopted from an earlier provisioning that
    // kept no record, has no knowable upstream version; it still has to be a
    // real, runnable executable matching its recorded digest.
  } else if (record.version !== expected.version) {
    return `provisioned from ${record.version ?? 'an unrecorded version'}, want ${expected.version}`;
  } else if (record.archiveSha256 !== expected.archiveSha256) {
    return 'provenance archive digest does not match the pinned digest';
  }
  if (!binary) return 'binary is missing';
  if (binary.bytes < MIN_WHISPER_BINARY_BYTES) {
    return `binary is only ${binary.bytes} bytes (minimum ${MIN_WHISPER_BINARY_BYTES})`;
  }
  if (!binary.executable) return 'binary is not executable';
  if (binary.sha256 !== record.binarySha256) return 'binary does not match its provenance digest';
  return probe?.problem ?? null;
}

/**
 * A working binary that predates provenance records. Adopting it beats forcing
 * a full whisper.cpp compile on every machine that already has one, and it is
 * still gated on the size floor, the executable bit and a real `--help` run —
 * the checks a placeholder or truncated file cannot pass. Pure.
 */
export function adoptable({ binary, probe }) {
  return Boolean(binary)
    && binary.bytes >= MIN_WHISPER_BINARY_BYTES
    && binary.executable
    && !probe?.problem;
}

async function readProvenance(binPath) {
  try {
    const parsed = JSON.parse(await readFile(binPath + PROVENANCE_SUFFIX, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function inspectBinary(binPath) {
  try {
    const info = await stat(binPath);
    if (!info.isFile()) return null;
    return {
      bytes: info.size,
      executable: process.platform === 'win32' || (info.mode & 0o111) !== 0,
      sha256: sha256Of(await readFile(binPath)),
    };
  } catch {
    return null;
  }
}

async function probeHelp(binPath) {
  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    execFile(binPath, ['--help'], { timeout: 30_000, maxBuffer: 8 << 20 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`;
      const code = error ? (error.code ?? 1) : 0;
      resolve({ problem: helpProbeProblem(code, output) });
    });
  });
}

async function writeProvenance(binPath, record) {
  // The legacy sidecar was written from whatever bytes were on disk and read by
  // nothing; drop it rather than keep a second, weaker record.
  await rm(binPath + LEGACY_DIGEST_SUFFIX, { force: true });
  await writeFile(binPath + PROVENANCE_SUFFIX, `${JSON.stringify(record, null, 2)}\n`);
}

async function installedRecord(binPath, source, spec, extra = {}) {
  const binary = await inspectBinary(binPath);
  if (!binary) throw new Error(`whisper-cli missing after provisioning: ${binPath}`);
  return {
    version: VERSION,
    platform: `${process.platform}-${process.arch}`,
    source,
    asset: spec.asset ?? null,
    archiveSha256: spec.archiveSha256 ?? null,
    binaryBytes: binary.bytes,
    binarySha256: binary.sha256,
    recordedAt: new Date().toISOString(),
    ...extra,
  };
}

// Find `executable` anywhere under `dir`. Depth-first, and it must backtrack:
// the old `return walk(full)` on the first subdirectory gave up on all later
// siblings, so an archive listing any other directory first would report
// "not found".
export async function findExecutable(dir, executable) {
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() && entry.name === executable) return join(dir, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const hit = await findExecutable(join(dir, entry.name), executable);
    if (hit) return hit;
  }
  return null;
}

// Bring the executable's WHOLE directory up to `targetDir`, not just the
// executable. The Windows archive nests everything under Release/, and moving
// only whisper-cli.exe out of it left ggml.dll, whisper.dll and the nine
// ggml-cpu-*.dll variants behind. Windows resolves a process's DLLs from the
// directory of the executable first, and native-asr-worker.ts spawns the binary
// with no cwd, so the exe could not start at all: verified on a windows-latest
// runner, `whisper-cli.exe --help` exits 127. That is issue #120 — Windows local
// transcription was never slow, it never ran. Linux has the same shape
// (libwhisper.so beside the binary, found through an $ORIGIN RUNPATH).
export async function flattenExecutableDir(targetDir, executable) {
  const { readdir } = await import('node:fs/promises');
  const found = await findExecutable(targetDir, executable);
  if (!found) throw new Error(`${executable} not found under ${targetDir}`);
  const sourceDir = dirname(found);
  if (sourceDir !== targetDir) {
    for (const name of await readdir(sourceDir)) {
      const to = join(targetDir, name);
      await rm(to, { recursive: true, force: true });
      await rename(join(sourceDir, name), to);
    }
    await rm(sourceDir, { recursive: true, force: true });
  }
  const binPath = join(targetDir, executable);
  if (!existsSync(binPath)) throw new Error(`${executable} missing after flatten: ${binPath}`);
  return binPath;
}

async function buildFromSource(srcDir, buildDir) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const binName = `whisper-cli${process.platform === 'win32' ? '.exe' : ''}`;
  const builtCli = join(buildDir, 'build', 'bin', binName);
  if (existsSync(builtCli)) return builtCli;
  if (!existsSync(join(srcDir, 'CMakeLists.txt'))) {
    await rm(srcDir, { recursive: true, force: true });
    await run('git', ['clone', '--depth', '1', '--branch', VERSION, 'https://github.com/ggml-org/whisper.cpp.git', srcDir]);
  }
  const metalFlag = process.platform === 'darwin' ? ['-DGGML_METAL=ON', '-DGGML_METAL_EMBED_LIBRARY=ON'] : [];
  try {
    await run('cmake', ['--version']);
  } catch {
    throw new Error('cmake is required to build whisper.cpp on this platform (brew install cmake); or set OPENCHATCUT_WHISPER_CLI to a prebuilt binary');
  }
  await run('cmake', ['-B', join(buildDir, 'build'), '-DCMAKE_BUILD_TYPE=Release', ...metalFlag, srcDir]);
  await run('cmake', ['--build', join(buildDir, 'build'), '--config', 'Release', '-j', '--target', 'whisper-cli', 'whisper-server']);
  return builtCli;
}

async function copyExecutable(from, to) {
  await rm(to, { force: true });
  await writeFile(to, await readFile(from));
  await chmod(to, 0o755);
}

/** The persistent whisper-server binary lives next to the CLI; ship it when present. */
async function copyServerBeside(sourceBin, targetDir) {
  const name = `whisper-server${process.platform === 'win32' ? '.exe' : ''}`;
  const from = join(dirname(sourceBin), name);
  if (!existsSync(from)) return;
  await copyExecutable(from, join(targetDir, name));
}

async function provisionFromOverride(override, binPath, targetDir, spec) {
  console.log(`[whisper-cli] using override ${override}`);
  await mkdir(targetDir, { recursive: true });
  await copyExecutable(override, binPath);
  await copyServerBeside(override, targetDir);
  return await installedRecord(binPath, 'override', spec, { overridePath: override });
}

async function provisionFromSource(binPath, targetDir, spec, platformKey) {
  const srcDir = join(BUILD_CACHE, 'whisper.cpp');
  const cli = await buildFromSource(srcDir, BUILD_CACHE);
  await mkdir(targetDir, { recursive: true });
  await copyExecutable(cli, binPath);
  await copyServerBeside(cli, targetDir);
  console.log(`[whisper-cli] built ${platformKey} from source -> ${binPath}`);
  return await installedRecord(binPath, 'build', spec);
}

async function provisionFromAsset(binPath, targetDir, spec, platformKey) {
  const url = `${BASE}/${spec.asset}`;
  console.log(`[whisper-cli] downloading ${url}`);
  const bytes = await fetchArchive(url);
  const problem = archiveProblem(bytes, spec);
  if (problem) throw new Error(`refusing ${spec.asset}: ${problem}`);
  const archive = join(OUT_DIR, `${platformKey}.${spec.asset.endsWith('.zip') ? 'zip' : 'tar.gz'}`);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(archive, bytes);
  try {
    await extractArchive(archive, targetDir);
    // Official archives nest the CLI and its libraries together; bring that
    // whole directory up so the binary keeps its DLLs / shared objects.
    await flattenExecutableDir(targetDir, spec.executable);
  } finally {
    await rm(archive, { force: true });
  }
  if (process.platform !== 'win32') await chmod(binPath, 0o755);
  return await installedRecord(binPath, 'asset', spec);
}

async function inspectProvisioned(binPath, spec) {
  const record = await readProvenance(binPath);
  const binary = await inspectBinary(binPath);
  const probe = binary ? await probeHelp(binPath) : null;
  const snapshot = {
    expected: { version: VERSION, archiveSha256: spec.archiveSha256 ?? null },
    record,
    binary,
    probe,
  };
  return { ...snapshot, problem: provisionedProblem(snapshot) };
}

async function main() {
  const platformKey = `${process.platform}-${process.arch}`;
  const spec = PLATFORMS[platformKey];
  if (!spec) throw new Error(`unsupported platform ${platformKey}`);
  const targetDir = join(OUT_DIR, platformKey);
  const binPath = join(targetDir, spec.executable);
  const override = process.env.OPENCHATCUT_WHISPER_CLI;

  if (!override) {
    const state = await inspectProvisioned(binPath, spec);
    if (!state.problem) {
      console.log(`[whisper-cli] ${platformKey} verified at ${binPath}`);
      return;
    }
    // Release-asset platforms re-fetch a few megabytes; source-build platforms
    // would pay a full compile, so a binary that still runs is adopted.
    if (!spec.asset && !state.record && adoptable(state)) {
      await writeProvenance(binPath, await installedRecord(binPath, 'adopted', spec, { version: null }));
      console.log(`[whisper-cli] adopted the existing ${platformKey} binary at ${binPath} (it runs; no provenance existed)`);
      return;
    }
    console.log(`[whisper-cli] re-provisioning ${platformKey}: ${state.problem}`);
  }

  const record = override
    ? await provisionFromOverride(override, binPath, targetDir, spec)
    : spec.asset
      ? await provisionFromAsset(binPath, targetDir, spec, platformKey)
      : await provisionFromSource(binPath, targetDir, spec, platformKey);
  await writeProvenance(binPath, record);

  const { problem } = await inspectProvisioned(binPath, spec);
  if (problem) {
    // Never leave unusable bytes behind with a record vouching for them: the
    // next run must see an empty slot, not a certified-bad binary.
    await rm(binPath, { force: true });
    await rm(binPath + PROVENANCE_SUFFIX, { force: true });
    throw new Error(`${binPath} failed verification after provisioning: ${problem}`);
  }
  console.log(`[whisper-cli] ${platformKey} ready at ${binPath} (${record.binaryBytes} bytes, ${record.source})`);
}

// Only provision when invoked directly, so the verify can import the flatten
// helpers without triggering a download.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[whisper-cli] ${error.message}`);
    process.exitCode = 1;
  });
}
