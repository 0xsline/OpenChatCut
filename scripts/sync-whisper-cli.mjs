// Provision the whisper.cpp CLI binary used by the desktop native-ASR worker.
//
// Platform sources:
// - darwin-arm64: no official release asset exists; the build machine compiles
//   from source (see README of whisper.cpp) and the binary is supplied via
//   OPENCHATCUT_WHISPER_CLI or copied into public/whisper-cli/darwin-arm64/.
//   As a fallback the official x64 build can be fetched (Rosetta).
// - darwin-x64 / win32-x64 / linux-x64 / linux-arm64: official GitHub release
//   assets (whisper-bin-*), verified by size + sha256 recorded at first fetch.
//
// Output: public/whisper-cli/<platform>/whisper-cli[.exe]
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(ROOT, 'public', 'whisper-cli');
const VERSION = 'v1.9.2';
const BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${VERSION}`;

const PLATFORMS = {
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
  'win32-x64': { asset: 'whisper-bin-x64.zip', executable: 'whisper-cli.exe' },
  'linux-x64': { asset: 'whisper-bin-ubuntu-x64.tar.gz', executable: 'whisper-cli' },
  'linux-arm64': { asset: 'whisper-bin-ubuntu-arm64.tar.gz', executable: 'whisper-cli' },
};

async function download(url, dest) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed ${response.status} for ${url}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(dest, bytes);
  return bytes.length;
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

async function buildFromSource(srcDir, buildDir, platformKey) {
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
  await run('cmake', ['-B', join(buildDir, 'build'), '-DCMAKE_BUILD_TYPE=Release', ...metalFlag, srcDir]);
  await run('cmake', ['--build', join(buildDir, 'build'), '--config', 'Release', '-j', '--target', 'whisper-cli', 'whisper-server']);
  return builtCli;
}

async function main() {
  const platformKey = `${process.platform}-${process.arch}`;
  const spec = PLATFORMS[platformKey];
  if (!spec) throw new Error(`unsupported platform ${platformKey}`);
  const targetDir = join(OUT_DIR, platformKey);
  const binPath = join(targetDir, spec.executable);
  const override = process.env.OPENCHATCUT_WHISPER_CLI;
  if (override) {
    console.log(`[whisper-cli] using override ${override}`);
    await mkdir(targetDir, { recursive: true });
    await rename(override, binPath).catch(async () => {
      await rm(binPath, { force: true });
      await writeFile(binPath, await readFile(override));
    });
    await rm(binPath + '.sha256', { force: true });
    await writeFile(
      binPath + '.sha256',
      sha256Of(await readFile(binPath)),
    );
    console.log(`[whisper-cli] copied ${override} -> ${binPath}`);
    // The persistent whisper-server binary lives next to the CLI; ship it
    // when present (locally compiled builds provide it).
    const serverSrc = join(dirname(override), `whisper-server${process.platform === 'win32' ? '.exe' : ''}`);
    const serverDst = join(targetDir, `whisper-server${process.platform === 'win32' ? '.exe' : ''}`);
    if (existsSync(serverSrc)) {
      await rm(serverDst, { force: true });
      await writeFile(serverDst, await readFile(serverSrc));
      console.log(`[whisper-cli] copied ${serverSrc} -> ${serverDst}`);
    }
    return;
  }
  if (!spec.asset) {
    // macOS has no official release asset: build from source (local or CI).
    // OPENCHATCUT_WHISPER_CLI still wins when set.
    const buildDir = join(OUT_DIR, 'build-src');
    const srcDir = join(buildDir, 'whisper.cpp');
    const cli = await buildFromSource(srcDir, buildDir, platformKey);
    await mkdir(targetDir, { recursive: true });
    await writeFile(binPath, await readFile(cli));
    await rm(binPath + '.sha256', { force: true });
    await writeFile(binPath + '.sha256', sha256Of(await readFile(binPath)));
    const serverBin = join(dirname(cli), `whisper-server${process.platform === 'win32' ? '.exe' : ''}`);
    const serverDst = join(targetDir, `whisper-server${process.platform === 'win32' ? '.exe' : ''}`);
    if (existsSync(serverBin)) {
      await writeFile(serverDst, await readFile(serverBin));
    }
    console.log(`[whisper-cli] built ${platformKey} from source -> ${binPath}`);
    return;
  }
  const archive = join(OUT_DIR, `${platform}.${spec.asset.split('.').slice(-1)[0] === 'zip' ? 'zip' : 'tar.gz'}`);
  const url = `${BASE}/${spec.asset}`;
  if (!existsSync(binPath)) {
    console.log(`[whisper-cli] downloading ${url}`);
    await download(url, archive);
    await extractArchive(archive, targetDir);
    // Official archives contain the CLI at a nested path; flatten the first match.
    const { readdir } = await import('node:fs/promises');
    const walk = async (dir) => {
      for (const name of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, name.name);
        if (name.isDirectory()) return walk(full);
        if (name.name === spec.executable) return full;
      }
      return null;
    };
    const found = await walk(targetDir);
    if (!found || !existsSync(found)) throw new Error(`whisper-cli executable not found in ${spec.asset}`);
    if (found !== binPath) {
      await rm(binPath, { force: true });
      await rename(found, binPath);
    }
    await rm(archive, { force: true });
  }
  const bytes = await readFile(binPath);
  await rm(binPath + '.sha256', { force: true });
  await writeFile(binPath + '.sha256', sha256Of(bytes));
  console.log(`[whisper-cli] ${platform} ready at ${binPath} (${bytes.length} bytes)`);
}

main().catch((error) => {
  console.error(`[whisper-cli] ${error.message}`);
  process.exitCode = 1;
});
