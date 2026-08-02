import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';
import { codexCommand } from './command.ts';

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 16 * 1024;
export const MINIMUM_CODEX_VERSION = '0.146.0';

export interface CodexInstallation {
  readonly installed: boolean;
  readonly supported: boolean;
  readonly path: string | null;
  readonly version: string | null;
}

function executableNames(name = 'codex'): string[] {
  if (process.platform !== 'win32' || /\.(?:exe|cmd|bat)$/i.test(name)) return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

function pathCandidates(name: string): string[] {
  const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return entries.flatMap((entry) => executableNames(name).map((file) => join(entry, file)));
}

function configuredCandidates(): string[] {
  const configured = process.env.OPENCHATCUT_CODEX_PATH?.trim();
  if (!configured) return [];
  if (isAbsolute(configured) || configured.includes(sep) || configured.includes('/')) {
    return [resolve(configured)];
  }
  return pathCandidates(configured);
}

function commonCandidates(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    return [
      process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'codex.cmd') : '',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'codex', 'codex.exe') : '',
      process.env.USERPROFILE ? join(process.env.USERPROFILE, '.local', 'bin', 'codex.exe') : '',
    ].filter(Boolean);
  }
  return [
    join(home, '.local', 'bin', 'codex'),
    join(home, '.npm-global', 'bin', 'codex'),
    join(home, '.bun', 'bin', 'codex'),
    join(home, '.volta', 'bin', 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    '/usr/bin/codex',
  ];
}

async function executable(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    if (process.platform !== 'win32') await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexCli(): Promise<string | null> {
  const candidates = [
    ...configuredCandidates(),
    ...pathCandidates('codex'),
    ...commonCandidates(),
  ];
  const unique = [...new Set(candidates)];
  const checks = await Promise.all(unique.map(async (candidate) => ({
    candidate,
    executable: await executable(candidate),
  })));
  return checks.find((check) => check.executable)?.candidate ?? null;
}

function parseVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  return match?.[1] ?? null;
}

function versionParts(version: string): readonly number[] {
  return version.split(/[.+-]/, 3).map((part) => Number.parseInt(part, 10));
}

export function isSupportedCodexVersion(version: string | null): boolean {
  if (!version) return false;
  const actual = versionParts(version);
  const minimum = versionParts(MINIMUM_CODEX_VERSION);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return (actual[index] ?? 0) > (minimum[index] ?? 0);
  }
  return !version.includes('-');
}

async function readVersion(path: string): Promise<string | null> {
  const command = codexCommand(path, ['--version']);
  const { promise, resolve } = Promise.withResolvers<string | null>();
  execFile(command.executable, command.args, {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
    maxBuffer: VERSION_OUTPUT_LIMIT,
    windowsHide: true,
    windowsVerbatimArguments: command.windowsVerbatimArguments,
  }, (error, stdout, stderr) => {
    resolve(error ? null : parseVersion(`${stdout}\n${stderr}`));
  });
  return promise;
}

export async function inspectCodexInstallation(): Promise<CodexInstallation> {
  const path = await resolveCodexCli();
  if (!path) return { installed: false, supported: false, path: null, version: null };
  const version = await readVersion(path);
  return { installed: true, supported: isSupportedCodexVersion(version), path, version };
}
