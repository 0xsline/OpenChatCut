import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path';

const VERSION_TIMEOUT_MS = 10_000;
const VERSION_OUTPUT_LIMIT = 16 * 1024;
/** Floor for the SDK surface the spike relies on (defineTool handlers, assistant.usage). */
export const MINIMUM_COPILOT_VERSION = '1.0.0';

export interface CopilotInstallation {
  readonly installed: boolean;
  readonly supported: boolean;
  readonly path: string | null;
  readonly version: string | null;
}

function executableNames(name = 'copilot'): string[] {
  if (process.platform !== 'win32' || /\.(?:exe|cmd|bat)$/i.test(name)) return [name];
  return [`${name}.exe`, `${name}.cmd`, `${name}.bat`];
}

function pathCandidates(name: string): string[] {
  const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  return entries.flatMap((entry) => executableNames(name).map((file) => join(entry, file)));
}

function configuredCandidates(): string[] {
  const configured = process.env.OPENCHATCUT_COPILOT_PATH?.trim();
  if (!configured) return [];
  if (isAbsolute(configured) || configured.includes(sep) || configured.includes('/')) {
    return [resolve(configured)];
  }
  return pathCandidates(configured);
}

/**
 * The npm platform package `@github/copilot-sdk` prefers. Resolving it first
 * lets a bundled install win over whatever the user happens to have on PATH.
 */
function bundledCandidates(): string[] {
  const platformPackage = `@github/copilot-${process.platform}-${process.arch}`;
  const binary = process.platform === 'win32' ? 'copilot.exe' : 'copilot';
  try {
    const entry = import.meta.resolve?.(`${platformPackage}/package.json`);
    if (!entry?.startsWith('file:')) return [];
    return [join(new URL('.', entry).pathname, binary)];
  } catch {
    return [];
  }
}

function commonCandidates(): string[] {
  const home = homedir();
  if (process.platform === 'win32') {
    return [
      process.env.APPDATA ? join(process.env.APPDATA, 'npm', 'copilot.cmd') : '',
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'copilot', 'copilot.exe') : '',
      process.env.USERPROFILE ? join(process.env.USERPROFILE, '.local', 'bin', 'copilot.exe') : '',
    ].filter(Boolean);
  }
  return [
    join(home, '.local', 'bin', 'copilot'),
    join(home, '.npm-global', 'bin', 'copilot'),
    join(home, '.bun', 'bin', 'copilot'),
    join(home, '.volta', 'bin', 'copilot'),
    '/opt/homebrew/bin/copilot',
    '/usr/local/bin/copilot',
    '/usr/bin/copilot',
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

export async function resolveCopilotCli(): Promise<string | null> {
  const candidates = [
    ...configuredCandidates(),
    ...bundledCandidates(),
    ...pathCandidates('copilot'),
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

export function isSupportedCopilotVersion(version: string | null): boolean {
  if (!version) return false;
  const actual = versionParts(version);
  const minimum = versionParts(MINIMUM_COPILOT_VERSION);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return (actual[index] ?? 0) > (minimum[index] ?? 0);
  }
  return true;
}

async function readVersion(path: string): Promise<string | null> {
  const { promise, resolve: settle } = Promise.withResolvers<string | null>();
  execFile(path, ['--version'], {
    encoding: 'utf8',
    timeout: VERSION_TIMEOUT_MS,
    maxBuffer: VERSION_OUTPUT_LIMIT,
    windowsHide: true,
  }, (error, stdout, stderr) => {
    settle(error ? null : parseVersion(`${stdout}\n${stderr}`));
  });
  return promise;
}

export async function inspectCopilotInstallation(): Promise<CopilotInstallation> {
  const path = await resolveCopilotCli();
  if (!path) return { installed: false, supported: false, path: null, version: null };
  const version = await readVersion(path);
  return { installed: true, supported: isSupportedCopilotVersion(version), path, version };
}
