import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import { scanSystemFonts, systemFontsPlugin } from './system-fonts.ts';

const plugin = systemFontsPlugin();
assert.equal(plugin.name, 'openchatcut-system-fonts');

const fixture = mkdtempSync(join(tmpdir(), 'occ-font-scan-'));
try {
  const nested = join(fixture, 'truetype', 'fixture');
  mkdirSync(nested, { recursive: true });
  const family = Buffer.from('Nested Font Fixture', 'utf16le');
  family.swap16();
  const names = Buffer.alloc(18 + family.length);
  names.writeUInt16BE(1, 2);
  names.writeUInt16BE(18, 4);
  names.writeUInt16BE(3, 6);
  names.writeUInt16BE(1, 8);
  names.writeUInt16BE(16, 12);
  names.writeUInt16BE(family.length, 14);
  family.copy(names, 18);
  const font = Buffer.alloc(28 + names.length);
  font.writeUInt32BE(0x00010000);
  font.writeUInt16BE(1, 4);
  font.write('name', 12);
  font.writeUInt32BE(28, 20);
  font.writeUInt32BE(names.length, 24);
  names.copy(font, 28);
  writeFileSync(join(nested, 'fixture.ttf'), font);
  const labels = ['Localized Alias', 'Canonical Font Fixture'].map((value) => {
    const buffer = Buffer.from(value, 'utf16le');
    buffer.swap16();
    return buffer;
  });
  const canonicalNames = Buffer.alloc(30 + labels[0]!.length + labels[1]!.length);
  canonicalNames.writeUInt16BE(2, 2);
  canonicalNames.writeUInt16BE(30, 4);
  let stringOffset = 0;
  for (let i = 0; i < 2; i++) {
    const record = 6 + i * 12;
    canonicalNames.writeUInt16BE(3, record);
    canonicalNames.writeUInt16BE(1, record + 2);
    canonicalNames.writeUInt16BE(i === 0 ? 0x0404 : 0x0409, record + 4);
    canonicalNames.writeUInt16BE(16, record + 6);
    canonicalNames.writeUInt16BE(labels[i]!.length, record + 8);
    canonicalNames.writeUInt16BE(stringOffset, record + 10);
    labels[i]!.copy(canonicalNames, 30 + stringOffset);
    stringOffset += labels[i]!.length;
  }
  const canonicalFont = Buffer.concat([font.subarray(0, 28), canonicalNames]);
  canonicalFont.writeUInt32BE(canonicalNames.length, 24);
  writeFileSync(join(nested, 'canonical.ttf'), canonicalFont);
  const links = join(fixture, 'links');
  mkdirSync(links);
  symlinkSync(join(nested, 'canonical.ttf'), join(links, 'linked.ttf'));
  symlinkSync(join(fixture, 'missing.ttf'), join(links, 'broken.ttf'));
  assert.deepEqual(scanSystemFonts(true, { userDirs: [links], systemDirs: [] }).allFonts, ['Canonical Font Fixture']);
  writeFileSync(join(nested, 'broken.ttf'), Buffer.from('broken'));
  assert.deepEqual(scanSystemFonts(true, { userDirs: [fixture], systemDirs: [] }).allFonts, ['Canonical Font Fixture', 'Nested Font Fixture']);

  // A small collection can reference one oversized string thousands of times.
  // Run it in a child so an unbounded parser cannot hang the verification suite.
  const records = 5401;
  const faces = 16;
  const oversized = Buffer.from('X'.repeat(32767), 'utf16le').swap16();
  const budgetFamily = Buffer.from('Budget Font Fixture', 'utf16le').swap16();
  const budgetNames = Buffer.alloc(6 + records * 12 + oversized.length + budgetFamily.length);
  budgetNames.writeUInt16BE(records, 2);
  budgetNames.writeUInt16BE(6 + records * 12, 4);
  for (let i = 0; i < records; i++) {
    const record = 6 + i * 12;
    budgetNames.writeUInt16BE(3, record);
    budgetNames.writeUInt16BE(1, record + 2);
    budgetNames.writeUInt16BE(i === records - 1 ? 0x0409 : i, record + 4);
    budgetNames.writeUInt16BE(i === records - 1 ? 16 : 1, record + 6);
    budgetNames.writeUInt16BE(i === records - 1 ? budgetFamily.length : oversized.length, record + 8);
    budgetNames.writeUInt16BE(i === records - 1 ? oversized.length : 0, record + 10);
  }
  oversized.copy(budgetNames, 6 + records * 12);
  budgetFamily.copy(budgetNames, 6 + records * 12 + oversized.length);
  const faceOffset = 12 + faces * 4;
  const collection = Buffer.alloc(faceOffset + 28 + budgetNames.length);
  collection.write('ttcf');
  collection.writeUInt32BE(0x00010000, 4);
  collection.writeUInt32BE(faces, 8);
  for (let i = 0; i < faces; i++) collection.writeUInt32BE(faceOffset, 12 + i * 4);
  font.subarray(0, 28).copy(collection, faceOffset);
  collection.writeUInt32BE(faceOffset + 28, faceOffset + 20);
  collection.writeUInt32BE(budgetNames.length, faceOffset + 24);
  budgetNames.copy(collection, faceOffset + 28);
  const budgetDir = join(fixture, 'budget');
  mkdirSync(budgetDir);
  writeFileSync(join(budgetDir, 'budget.ttc'), collection);
  const bounded = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
    `import { scanSystemFonts } from './server/plugins/system-fonts.ts'; console.log(JSON.stringify(scanSystemFonts(true, { userDirs: [process.argv[1]], systemDirs: [] }).allFonts));`, budgetDir],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
  assert.equal(bounded.status, 0, `font parsing must finish within its budget: ${bounded.error?.message ?? bounded.stderr}`);
  assert.deepEqual(JSON.parse(bounded.stdout), ['Budget Font Fixture']);
} finally {
  rmSync(fixture, { recursive: true, force: true });
  scanSystemFonts(true);
}

let server: ViteDevServer | undefined;
try {
  server = await createServer({
    configFile: false,
    appType: 'custom',
    logLevel: 'silent',
    plugins: [systemFontsPlugin()],
    server: { host: '127.0.0.1', port: 0 },
  });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address === 'object');

  const origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/api/system-fonts`, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(response.status, 200);

  const data = await response.json() as {
    ok: boolean;
    userFonts: string[];
    systemFonts: string[];
    allFonts: string[];
    timestamp: number;
  };

  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.userFonts));
  assert.ok(Array.isArray(data.systemFonts));
  assert.ok(Array.isArray(data.allFonts));
  assert.ok(typeof data.timestamp === 'number');

  // POST or refresh=1 test
  const refreshResponse = await fetch(`${origin}/api/system-fonts?refresh=1`, { headers: { 'Sec-Fetch-Site': 'none' } });
  assert.equal(refreshResponse.status, 200);
  const refreshData = await refreshResponse.json() as { ok: boolean; allFonts: string[] };
  assert.equal(refreshData.ok, true);
  assert.ok(Array.isArray(refreshData.allFonts));
  for (const headers of [
    { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'none', Host: 'rebind.example' },
  ]) {
    const denied = await new Promise<number>((resolve, reject) => {
      request(`${origin}/api/system-fonts?refresh=1`, { headers }, (response) => {
        response.resume();
        resolve(response.statusCode!);
      }).on('error', reject).end();
    });
    assert.equal(denied, 403, 'inventory reads must enforce the local-device trust boundary');
  }
  const post = await fetch(`${origin}/api/system-fonts`, { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(post.status, 403);
} finally {
  await server?.close();
}

console.log('system-fonts plugin verification passed');
