import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  chmod, link, lstat, mkdir, open, readFile, readdir, realpath, rm, stat,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

export const DEV_PROFILE_METADATA = 'openchatcut-dev-profile.json';
export const DEV_PROFILE_ID_ENV = 'OPENCHATCUT_DEV_PROFILE_ID';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const execFileAsync = promisify(execFile);

function profileError(metadataPath, reason) {
  return new Error(
    `Invalid isolated development profile metadata at ${metadataPath}: ${reason}. `
    + `Remove that file to regenerate this checkout's profile.`,
  );
}

function strictMetadata(value, metadataPath) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw profileError(metadataPath, 'expected an object');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'profileId,repoRoot,version') {
    throw profileError(metadataPath, 'expected only version, profileId, and repoRoot');
  }
  if (value.version !== 1 || typeof value.profileId !== 'string' || !UUID_V4.test(value.profileId)) {
    throw profileError(metadataPath, 'unsupported version or invalid profileId');
  }
  if (typeof value.repoRoot !== 'string' || !isAbsolute(value.repoRoot) || resolve(value.repoRoot) !== value.repoRoot) {
    throw profileError(metadataPath, 'repoRoot must be a normalized absolute path');
  }
  return Object.freeze({ version: 1, profileId: value.profileId, repoRoot: value.repoRoot });
}

async function readMetadata(metadataPath) {
  let info;
  try {
    info = await lstat(metadataPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
    throw profileError(metadataPath, 'metadata must be a small regular file');
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(metadataPath, 'utf8'));
  } catch {
    throw profileError(metadataPath, 'file is not valid JSON');
  }
  return strictMetadata(parsed, metadataPath);
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  } finally {
    await handle?.close();
  }
}

async function writeMetadataCandidate(metadataPath, metadata) {
  const temporary = join(
    dirname(metadataPath),
    `.${DEV_PROFILE_METADATA}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(metadata)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, metadataPath);
    await syncDirectory(dirname(metadataPath));
    return metadata;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const winner = await readMetadata(metadataPath);
    if (!winner) throw profileError(metadataPath, 'concurrent creation did not publish metadata');
    return winner;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true });
  }
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Refusing non-directory isolated profile path: ${directory}`);
  }
  await chmod(directory, 0o700).catch(() => undefined);
}

async function ensureProfileDirectories(homeDir, profileId) {
  const appRoot = join(homeDir, '.openchatcut');
  const profilesRoot = join(appRoot, 'dev-profiles');
  const rootDir = join(profilesRoot, profileId);
  const directories = [
    appRoot,
    profilesRoot,
    rootDir,
    join(rootDir, 'electron-user-data'),
    join(rootDir, 'project-store-auth-v1'),
    join(rootDir, 'media'),
    join(rootDir, 'media', 'uploads'),
    join(rootDir, 'project-store-v1'),
  ];
  for (const directory of directories) await ensurePrivateDirectory(directory);
  return rootDir;
}

function assertMetadataRepo(metadata, repoRoot, metadataPath) {
  if (metadata.repoRoot !== repoRoot) {
    throw profileError(
      metadataPath,
      `repoRoot changed from ${metadata.repoRoot} to ${repoRoot}`,
    );
  }
}

export async function loadOrCreateDevProfile(options) {
  const { gitDir, repoRoot, homeDir, randomId = randomUUID } = options;
  if (!isAbsolute(gitDir) || !isAbsolute(repoRoot) || !isAbsolute(homeDir)) {
    throw new Error('Isolated development profile paths must be absolute');
  }
  const metadataPath = join(gitDir, DEV_PROFILE_METADATA);
  let metadata = await readMetadata(metadataPath);
  if (!metadata) {
    const candidate = strictMetadata({ version: 1, profileId: randomId(), repoRoot }, metadataPath);
    metadata = await writeMetadataCandidate(metadataPath, candidate);
  }
  assertMetadataRepo(metadata, repoRoot, metadataPath);
  await chmod(metadataPath, 0o600).catch(() => undefined);
  const rootDir = await ensureProfileDirectories(homeDir, metadata.profileId);
  return Object.freeze({
    id: metadata.profileId,
    rootDir,
    metadataPath,
    keystorePath: join(rootDir, 'settings.env'),
  });
}

export function parseProfileEnv(text) {
  const parsed = {};
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    const delimiter = value[0];
    if (value.length >= 2 && ['"', "'", '`'].includes(delimiter) && value.endsWith(delimiter)) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf('#');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    value = value.replace(/\\\$/g, '$');
    parsed[match[1]] = value;
  }
  return parsed;
}

async function readProfileEnv(path) {
  try {
    return parseProfileEnv(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * In dev, Remotion serves headless preview/render from the local
 * Node_modules/.remotion cache (versioned by the installed @remotion/* version).
 * The desktop packaging path sets CC_BROWSER_EXECUTABLE explicitly so the packaged
 * app never redownloads; dev historically left it unset, so every openBrowser()
 * re-downloaded the pinned headless-shell and could stall preview/render.
 *
 * Here we behave like the packaged runtime: if the caller did not explicitly set
 * CC_BROWSER_EXECUTABLE, resolve the installed .remotion headless-shell and pass
 * it through. Remotion treats an explicit browserExecutable as user-defined and
 * skips its own download checks, so dev stops re-downloading once the shell exists.
 * Returns undefined when nothing usable is found (caller falls back to Remotion).
 */
export async function resolveDevHeadlessShell(root = process.cwd(), environment = process.env) {
  if (environment.CC_BROWSER_EXECUTABLE) return undefined;
  const remotionDir = join(root, 'node_modules', '.remotion', 'chrome-headless-shell');
  let platformDirs;
  try {
    platformDirs = await readdir(remotionDir);
  } catch {
    return undefined;
  }
  for (const platformDir of platformDirs.sort()) {
    if (platformDir === 'VERSION') continue;
    const appDir = join(remotionDir, platformDir);
    let candidates;
    try {
      candidates = await readdir(appDir);
    } catch {
      continue;
    }
    for (const candidate of candidates.sort()) {
      const candidatePath = join(appDir, candidate);
      let candidateStat;
      try {
        candidateStat = await stat(candidatePath);
      } catch {
        continue;
      }
      if (!candidateStat.isDirectory()) continue;
      const executableName = process.platform === 'win32'
        ? 'chrome-headless-shell.exe'
        : 'chrome-headless-shell';
      const exePath = join(candidatePath, executableName);
      try {
        const exeStat = await stat(exePath);
        const executable = process.platform === 'win32' || (exeStat.mode & 0o111) !== 0;
        if (exeStat.isFile() && executable) return exePath;
      } catch {
        // try next candidate
      }
    }
  }
  return undefined;
}

export async function profileChildEnvironment(
  profile,
  baseEnvironment = process.env,
  repoRoot = process.cwd(),
) {
  const saved = await readProfileEnv(profile.keystorePath);
  const environment = { ...baseEnvironment, ...saved, [DEV_PROFILE_ID_ENV]: profile.id };
  if (!environment.CC_BROWSER_EXECUTABLE) {
    const shellPath = await resolveDevHeadlessShell(repoRoot, environment);
    if (shellPath) environment.CC_BROWSER_EXECUTABLE = shellPath;
  }
  return environment;
}

function singleGitPath(stdout, label) {
  const value = stdout.trim();
  if (!value || value.includes('\n') || !isAbsolute(value)) {
    throw new Error(`git returned an invalid ${label}`);
  }
  return value;
}

async function gitPath(cwd, argument, label) {
  const { stdout } = await execFileAsync('git', ['rev-parse', argument], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024,
  });
  return realpath(singleGitPath(stdout, label));
}

export async function resolveDevProfile(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const homeDir = options.homeDir ?? homedir();
  const gitDir = await gitPath(cwd, '--absolute-git-dir', 'absolute git directory');
  const repoRoot = await gitPath(cwd, '--show-toplevel', 'repository root');
  return loadOrCreateDevProfile({ gitDir, repoRoot, homeDir });
}

async function runProfileCommand(profile, command, args) {
  const environment = await profileChildEnvironment(profile);
  const npmCli = command === 'npm' ? process.env.npm_execpath : undefined;
  const executable = npmCli ? process.execPath : command;
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, commandArgs, {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: environment,
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => resolveRun(code ?? (signal ? 1 : 0)));
  });
}

async function runVite(profile, args) {
  const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  return runProfileCommand(profile, process.execPath, [viteCli, ...args]);
}

async function main() {
  const profile = await resolveDevProfile();
  const args = process.argv.slice(2);
  if (args[0] === '--exec') {
    const command = args[1];
    if (!command) throw new Error('--exec requires a command');
    process.exitCode = await runProfileCommand(profile, command, args.slice(2));
    return;
  }
  process.exitCode = await runVite(profile, args);
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === entryPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
