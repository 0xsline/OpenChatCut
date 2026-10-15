// How capcut-cli is launched on each platform, pinned without spawning it. On
// Windows npx is a .cmd batch shim: spawn('npx') is ENOENT, and since Node's
// CVE-2024-27980 fix a .cmd without a shell is EINVAL (#160). A shell would parse
// the draft name and file paths, so the launch must not need one.
import assert from 'node:assert/strict';
import { CAPCUT_CLI_PACKAGE, capcutCommand, capcutLaunch, type CapcutHost } from './capcut-command.ts';

// capcut-cli runs through `npx --yes` at export time; an unpinned spec would
// fetch and execute whatever release is newest on npm.
assert.match(CAPCUT_CLI_PACKAGE, /^capcut-cli@\d+\.\d+\.\d+$/, 'the default capcut-cli is an exact release');
if (!process.env.CAPCUT_CLI && process.platform !== 'win32') {
  assert.deepEqual(capcutCommand(), ['npx', '--yes', CAPCUT_CLI_PACKAGE], 'the default runs the pinned release');
}

// ── macOS / Linux: npx on PATH, a CAPCUT_CLI path as is ──────────────────────
for (const platform of ['darwin', 'linux'] as const) {
  assert.deepEqual(capcutCommand('capcut-cli@0.27.0', { platform }), ['npx', '--yes', 'capcut-cli@0.27.0'],
    'a CAPCUT_CLI package spec still goes through npx');
  assert.deepEqual(capcutCommand('/opt/capcut/bin/capcut-cli', { platform }), ['/opt/capcut/bin/capcut-cli'],
    'a CAPCUT_CLI path runs directly');
  assert.deepEqual(capcutCommand('/src/capcut-cli/dist/index.js', { platform }), ['/src/capcut-cli/dist/index.js'],
    'a script path relies on its shebang, as before');
  assert.deepEqual(capcutLaunch(['init', 'Q&A "cut"'], CAPCUT_CLI_PACKAGE, { platform }), {
    executable: 'npx',
    args: ['--yes', CAPCUT_CLI_PACKAGE, 'init', 'Q&A "cut"'],
  });
}

// ── Windows: what npx.cmd runs, without cmd.exe ──────────────────────────────
const NODE_DIR = 'C:\\Program Files\\nodejs';
const NODE = `${NODE_DIR}\\node.exe`;
const NPX_CLI = `${NODE_DIR}\\node_modules\\npm\\bin\\npx-cli.js`;
const ROAMING_NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const windows = (path: string, ...files: string[]): CapcutHost => ({
  platform: 'win32',
  env: { Path: path },
  isFile: (file) => files.includes(file),
});
// The installer puts node.exe, npx.cmd and npm side by side; PATH entries often end in "\".
const installed = windows(`C:\\WINDOWS\\system32;${NODE_DIR}\\;${ROAMING_NPM}`, NODE, NPX_CLI);

assert.deepEqual(capcutCommand(CAPCUT_CLI_PACKAGE, installed), [NODE, NPX_CLI, '--yes', CAPCUT_CLI_PACKAGE],
  'npx.cmd runs npm\'s npx-cli.js on the node.exe beside it; so does the exporter');
assert.deepEqual(capcutCommand('capcut-cli@0.27.0', installed), [NODE, NPX_CLI, '--yes', 'capcut-cli@0.27.0'],
  'a CAPCUT_CLI package spec takes the same route');
const draftArgs = [
  'init', 'Q&A "cut" 100% ^v2 | x',
  '--drafts', 'C:\\Users\\me\\AppData\\Local\\CapCut\\User Data\\Projects\\com.lveditor.draft',
];
assert.deepEqual(capcutLaunch(draftArgs, CAPCUT_CLI_PACKAGE, installed), {
  executable: NODE,
  args: [NPX_CLI, '--yes', CAPCUT_CLI_PACKAGE, ...draftArgs],
}, 'no shell: every argument reaches node.exe as is, with no quoting to break out of');

// A global `npm i -g npm` puts a newer npm first on PATH with no node.exe beside
// it; npx.cmd then runs it on the node.exe found on PATH, and so does this.
const updatedNpx = `${ROAMING_NPM}\\node_modules\\npm\\bin\\npx-cli.js`;
assert.deepEqual(capcutCommand(CAPCUT_CLI_PACKAGE, windows(`${ROAMING_NPM};${NODE_DIR}`, NODE, NPX_CLI, updatedNpx)),
  [NODE, updatedNpx, '--yes', CAPCUT_CLI_PACKAGE]);
assert.deepEqual(capcutCommand(CAPCUT_CLI_PACKAGE, {
  platform: 'win32',
  env: { PATH: `"${NODE_DIR}"` },
  isFile: (file) => file === NODE || file === NPX_CLI,
}), [NODE, NPX_CLI, '--yes', CAPCUT_CLI_PACKAGE], 'PATH in any case, quoted entries unquoted');
assert.deepEqual(capcutCommand(CAPCUT_CLI_PACKAGE, windows('C:\\WINDOWS\\system32')), ['npx', '--yes', CAPCUT_CLI_PACKAGE],
  'without npm on PATH only an npx.exe (Volta) can answer; otherwise the launch reports ENOENT');

// ── Windows CAPCUT_CLI paths ─────────────────────────────────────────────────
assert.deepEqual(capcutCommand('C:\\tools\\capcut.exe', installed), ['C:\\tools\\capcut.exe'],
  'an executable runs directly');
assert.deepEqual(capcutCommand('C:\\src\\capcut-cli\\dist\\index.js', installed), [NODE, 'C:\\src\\capcut-cli\\dist\\index.js'],
  'a local build\'s script cannot be executed on Windows; node runs it');
assert.deepEqual(capcutCommand('C:\\src\\capcut-cli\\dist\\index.js', windows('C:\\WINDOWS\\system32')),
  ['node', 'C:\\src\\capcut-cli\\dist\\index.js'], 'no node.exe found: spawn resolves "node" on PATH itself');
// An `npm i -g capcut-cli` shim is a batch file; only cmd.exe runs one, so it
// takes the Codex launcher's cmd.exe quoting (cross-spawn's): quoted, and every
// metacharacter caret-escaped.
const shim = capcutLaunch(['init', 'Q&A 100%'], 'C:\\tools\\capcut-cli.cmd', installed);
assert.match(shim.executable, /cmd\.exe$/i);
assert.equal(shim.windowsVerbatimArguments, true);
assert.deepEqual(shim.args, ['/d', '/s', '/c', '"C:\\tools\\capcut-cli.cmd ^"init^" ^"Q^&A^ 100^%^""']);
// The shim re-reads %*; a quote there would end the quoting, so none may reach it
// (Windows paths cannot hold one and the exporter strips it from draft names).
for (const unsafe of ['a" & calc & "', 'two\nlines']) {
  assert.throws(() => capcutLaunch(['init', unsafe], 'C:\\tools\\capcut-cli.cmd', installed), /quote or line break/,
    'refused, not passed to cmd.exe');
}

console.log('capcut-cli launch checks passed');
