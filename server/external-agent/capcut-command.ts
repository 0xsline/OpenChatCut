// How the JianYing / CapCut exporter launches capcut-cli.
//
// macOS and Linux spawn `npx --yes <package>` directly. Windows has no npx
// executable, only the npx.cmd batch shim: spawn('npx') is ENOENT, and since
// Node's CVE-2024-27980 fix a .cmd without a shell is EINVAL. `shell: true`
// would hand the draft name and file paths to cmd.exe unquoted, so Windows runs
// what npx.cmd itself runs, npm's npx-cli.js on node.exe, and every argument
// reaches node's argv as is. (npx then starts the capcut-cli bin the way it
// always does on Windows, through cmd.exe with npm's own argument escaping.)
import { statSync } from 'node:fs';
import { win32 } from 'node:path';
import { codexCommand, type CodexCommand } from '../codex/command.ts';

/**
 * Without a version, `npx --yes` fetches and runs whatever capcut-cli release
 * is newest on npm at export time, so an unreviewed or breaking publish would
 * execute on users' machines. Pin the release this exporter is known to work
 * with; bump it deliberately. CAPCUT_CLI still overrides it with a path to a
 * local build or another package spec.
 */
export const CAPCUT_CLI_PACKAGE = 'capcut-cli@0.26.0';

/** The machine a launch is built for; verification passes another platform and PATH. */
export interface CapcutHost {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (path: string) => boolean;
}

export type CapcutLaunch = CodexCommand;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** PATH entries on Windows, where the variable is usually spelled Path. */
function windowsPath(env: NodeJS.ProcessEnv): string[] {
  const value = Object.entries(env).find(([name]) => name.toUpperCase() === 'PATH')?.[1] ?? '';
  return value.split(';').map((entry) => entry.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

/** npx.cmd runs `node_modules\npm\bin\npx-cli.js` beside it on the node.exe
 * beside it, else on the node found on PATH; the first npm on PATH wins. */
function windowsNpx(dirs: string[], exists: (path: string) => boolean): string[] | null {
  const nodeOnPath = dirs.map((dir) => win32.join(dir, 'node.exe')).find(exists);
  for (const dir of dirs) {
    const npxCli = win32.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
    if (!exists(npxCli)) continue;
    const node = win32.join(dir, 'node.exe');
    const runtime = exists(node) ? node : nodeOnPath;
    if (runtime) return [runtime, npxCli];
  }
  return null;
}

/** Command prefix for a capcut-cli call: a local binary path, or npx with a package spec. */
export function capcutCommand(executable = process.env.CAPCUT_CLI || CAPCUT_CLI_PACKAGE, host: CapcutHost = {}): string[] {
  const { platform = process.platform, env = process.env, isFile: exists = isFile } = host;
  const dirs = platform === 'win32' ? windowsPath(env) : [];
  if (executable.includes('/') || executable.includes('\\')) {
    // Windows cannot execute a script, such as a local build's dist/index.js.
    if (platform !== 'win32' || !/\.[cm]?js$/i.test(executable)) return [executable];
    return [dirs.map((dir) => win32.join(dir, 'node.exe')).find(exists) ?? 'node', executable];
  }
  // No npm on PATH: only an npx.exe (Volta) can answer, else the launch is ENOENT.
  const npx = platform === 'win32' ? windowsNpx(dirs, exists) : null;
  return [...(npx ?? ['npx']), '--yes', executable];
}

/**
 * The process to spawn for one capcut-cli call. A .cmd/.bat CAPCUT_CLI (the
 * shim `npm i -g capcut-cli` installs) is a batch file only cmd.exe can run, so
 * it takes the Codex launcher's cmd.exe quoting (cross-spawn's): each argument
 * quoted and every metacharacter caret-escaped. The shim re-reads its
 * arguments through %*, where a quote inside one would end that quoting, and
 * cmd.exe cannot carry a line break; Windows paths hold neither and the
 * exporter strips both from draft names, so an argument with one is refused.
 */
export function capcutLaunch(args: readonly string[], executable?: string, host: CapcutHost = {}): CapcutLaunch {
  const [command, ...prefix] = capcutCommand(executable, host);
  const launch = codexCommand(command!, [...prefix, ...args], host.platform ?? process.platform);
  if (launch.windowsVerbatimArguments && args.some((arg) => /["\r\n]/.test(arg))) {
    throw new Error('capcut-cli: a .cmd/.bat CAPCUT_CLI cannot take an argument with a quote or line break');
  }
  return launch;
}
