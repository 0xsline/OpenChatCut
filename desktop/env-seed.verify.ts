// Runnable check: `npx tsx desktop/env-seed.verify.ts`.
// The packaged desktop app reads userData `.env.local` once at startup. Windows
// editors save a new file with CRLF line endings, and the settings in
// .env.example that the server reads from process.env (encoder override, export
// tuning) have no shell to come from in a packaged app, so both must reach the
// runtime from the file itself (issue #229).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getKey } from '../server/keystore.ts';
import { KEY_NAMES } from '../server/keystore-names.ts';
import { PROCESS_ENV_SETTING_NAMES } from '../server/process-env-settings.ts';
import { seedDesktopEnv } from './env-seed.ts';

const TOUCHED = [
  'AGENT_IMPORT_ROOTS',
  'GEMINI_API_KEY',
  'OPENCHATCUT_DISABLE_HARDWARE_ENCODING',
  'OPENCHATCUT_H264_ENCODER',
  'UPLOAD_MAX_BYTES',
] as const;
const inherited = new Map(TOUCHED.map((name) => [name, process.env[name]]));
for (const name of TOUCHED) delete process.env[name];

try {
  seedDesktopEnv([
    'AGENT_IMPORT_ROOTS=C:\\M1_test',
    'GEMINI_API_KEY=test-gemini-key',
    'OPENCHATCUT_H264_ENCODER=libx264',
    'OPENCHATCUT_DISABLE_HARDWARE_ENCODING=1',
    '',
  ].join('\r\n'));
  assert.equal(getKey('AGENT_IMPORT_ROOTS'), 'C:\\M1_test',
    'a CRLF .env.local must still seed keystore keys');
  assert.equal(getKey('GEMINI_API_KEY'), 'test-gemini-key');
  assert.equal(process.env.OPENCHATCUT_H264_ENCODER, 'libx264',
    'a process-env setting in .env.local must reach process.env');
  assert.equal(process.env.OPENCHATCUT_DISABLE_HARDWARE_ENCODING, '1');
  assert.equal(process.env.GEMINI_API_KEY, undefined,
    'keystore secrets stay out of process.env, which every child process inherits');

  // The file wins over an inherited value, the precedence seedKeystore gives keys;
  // an empty entry leaves the inherited value alone.
  process.env.OPENCHATCUT_H264_ENCODER = 'h264_qsv';
  process.env.UPLOAD_MAX_BYTES = '123';
  seedDesktopEnv('OPENCHATCUT_H264_ENCODER=libx264\nUPLOAD_MAX_BYTES=\n');
  assert.equal(process.env.OPENCHATCUT_H264_ENCODER, 'libx264');
  assert.equal(process.env.UPLOAD_MAX_BYTES, '123');
} finally {
  for (const [name, value] of inherited) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

// Every setting .env.example documents must reach the desktop runtime from
// `.env.local`, as a keystore key or as a copied process-env setting. An
// unregistered process-env setting would work under `npm run dev`, whose profile
// exports settings.env wholesale, and silently do nothing in the packaged app.
const keys = new Set<string>(KEY_NAMES);
const processEnvSettings = new Set<string>(PROCESS_ENV_SETTING_NAMES);
for (const name of processEnvSettings) {
  assert(!keys.has(name), `${name} is a keystore key and must not be copied into process.env`);
}
const documented = [
  ...readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
    .matchAll(/^[ \t]*#?[ \t]*([A-Z][A-Z0-9_]*)=/gm),
].map((match) => match[1]);
const unreachable = documented.filter((name) => !keys.has(name) && !processEnvSettings.has(name));
assert.deepEqual(unreachable, [],
  `.env.example settings the desktop app never reads from .env.local:\n${unreachable.join('\n')}`);

console.log('env-seed.verify: ok');
