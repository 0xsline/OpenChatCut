// checks:data-dir pure logic - path expansion, the pointer file round trip and its
// degradation, the writability probe, and relocation safety. Every case runs inside a
// temporary fixture home: nothing reads the developer's real storage root, and no
// network request exists in this file.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkDataDir,
  dataDirPointerPath,
  ensureDataDir,
  expandDataDir,
  readDataDirPointer,
  relocateDataDir,
  relocatedMediaDestination,
  relocatedUploadDir,
  writeDataDirPointer,
} from './data-dir.ts';

const fixture = await mkdtemp(join(tmpdir(), 'openchatcut-data-dir-'));
try {
  const home = join(fixture, 'home');
  await mkdir(home, { recursive: true });
  const defaultUploads = join(fixture, 'cwd', 'public', 'media', 'uploads');

  // 1. Expansion: `~/` and a bare `~` resolve against the given home, the result is
  // normalized, and anything that is not absolute afterwards is rejected rather than
  // silently resolved against the current working directory.
  assert.equal(expandDataDir('  ~/Saves  ', home), join(home, 'Saves'));
  assert.equal(expandDataDir('~', home), home);
  assert.equal(expandDataDir(join(fixture, 'a', '..', 'b'), home), join(fixture, 'b'));
  assert.equal(expandDataDir('relative/saves', home), null);
  assert.equal(expandDataDir('   ', home), null);
  assert.equal(expandDataDir('~someoneelse/saves', home), null); // `~` only expands before a slash

  // 2. Pointer file: fixed location outside the movable root, written 0600, read back
  // expanded, and cleared by an empty value (twice in a row must not throw).
  assert.equal(dataDirPointerPath(home), join(home, '.openchatcut', 'data-dir.json'));
  assert.equal(readDataDirPointer(home), null);
  const chosen = join(fixture, 'chosen');
  await writeDataDirPointer(chosen, home);
  assert.equal(readDataDirPointer(home), chosen);
  // POSIX permission bits: Windows reports no owner-only mode.
  if (process.platform !== 'win32') {
    assert.equal((await stat(dataDirPointerPath(home))).mode & 0o777, 0o600);
  }
  await writeDataDirPointer(null, home);
  assert.equal(readDataDirPointer(home), null);
  await writeDataDirPointer(null, home);

  // 3. A damaged pointer degrades to the default root instead of blocking startup:
  // startup resolves the profile synchronously and has nowhere to report an error.
  const pointer = dataDirPointerPath(home);
  await writeFile(pointer, 'not json at all');
  assert.equal(readDataDirPointer(home), null);
  await writeFile(pointer, JSON.stringify({ version: 1 }));
  assert.equal(readDataDirPointer(home), null);
  await writeFile(pointer, JSON.stringify({ version: 1, dataDir: 42 }));
  assert.equal(readDataDirPointer(home), null);
  await writeFile(pointer, JSON.stringify({ version: 1, dataDir: 'relative/saves' }));
  assert.equal(readDataDirPointer(home), null);
  await writeFile(pointer, JSON.stringify({ version: 1, dataDir: '~/Saves' }));
  assert.equal(readDataDirPointer(home), join(home, 'Saves'));
  await writeDataDirPointer(null, home);

  // 4. Writability probe: an empty value is legal and names the default root; a relative
  // path fails without creating anything; a valid path is created and left empty.
  const unset = await checkDataDir('  ', '/default/root');
  assert.equal(unset.ok, true);
  assert.match(unset.note ?? '', /默认目录 \/default\/root/);

  const relative = await checkDataDir('relative/saves', '/default/root');
  assert.equal(relative.ok, false);
  assert.match(relative.error ?? '', /绝对路径/);
  assert.equal(existsSync(join(process.cwd(), 'relative')), false, 'a rejected path must not be created');

  const probeTarget = join(fixture, 'probe-target');
  const probed = await checkDataDir(probeTarget, '/default/root');
  assert.equal(probed.ok, true);
  assert.match(probed.note ?? '', /目录可写/);
  assert.deepEqual(await readdir(probeTarget), [], 'the probe file is removed after the check');

  const blocked = join(fixture, 'blocked');
  await writeFile(blocked, 'a file where a directory is expected');
  const blockedProbe = await checkDataDir(blocked, '/default/root');
  assert.equal(blockedProbe.ok, false);
  assert.match(blockedProbe.error ?? '', /目录不可写/);

  // 5. Relocation copies the store entries, leaves regenerated files behind, and never
  // deletes the source: moving the storage root must not be the step that loses projects.
  // Media is deliberately NOT in the copied set: in the default profile uploads live
  // outside the root, so the caller copies them from the resolved upload directory.
  const source = join(fixture, 'source');
  await mkdir(join(source, 'project-store-v1'), { recursive: true });
  await writeFile(join(source, 'project-store-v1', 'projects.json'), '[]');
  await writeFile(join(source, 'deleted-projects-v1.json'), '{}');
  await writeFile(join(source, 'export-cache.log'), 'regenerated, stays behind');

  const logs: string[] = [];
  const destination = join(fixture, 'destination');
  assert.deepEqual(
    await relocateDataDir(source, destination, (msg) => logs.push(msg), false),
    { copiedEntries: 2 },
  );
  assert.equal(await readFile(join(destination, 'project-store-v1', 'projects.json'), 'utf8'), '[]');
  assert.ok(existsSync(join(source, 'project-store-v1', 'projects.json')), 'the source is kept intact');
  assert.equal(existsSync(join(destination, 'export-cache.log')), false, 'regenerated files are not carried over');
  assert.deepEqual(
    await relocateDataDir(source, source, () => { throw new Error('no log expected'); }, false),
    { copiedEntries: 0 },
  );

  // 5b. The SQLite store is the whole project store and cannot be copied file-wise while
  // live: relocation refuses rather than producing a torn snapshot or an empty new root.
  const sqliteLogs: string[] = [];
  const sqliteTarget = join(fixture, 'sqlite-destination');
  assert.deepEqual(
    await relocateDataDir(source, sqliteTarget, (msg) => sqliteLogs.push(msg), true),
    { refused: 'sqlite-store-active', copiedEntries: 0 },
  );
  assert.equal(existsSync(sqliteTarget), false, 'a refused relocation copies nothing at all');
  assert.ok(sqliteLogs.some((msg) => msg.includes('refused')), 'the refusal is reported, never silent');

  // 5c. The relocated upload directory is where the moved profile will resolve its
  // writable uploads, so the caller can copy media into the right place.
  assert.equal(relocatedUploadDir(destination), join(destination, 'media', 'uploads'));

  // 5c2. Media destination selection: setting the field moves media next to the
  // new root; clearing it returns to the checkout-relative default upload dir
  // (never rootDir/media/uploads, which the default profile does not read).
  assert.equal(
    relocatedMediaDestination(destination, destination, defaultUploads),
    join(destination, 'media', 'uploads'),
  );
  assert.equal(
    relocatedMediaDestination(null, join(fixture, 'home', '.openchatcut'), defaultUploads),
    defaultUploads,
  );

  // 5d. An interrupted relocation must never leave a half-copied entry looking complete.
  // The copy stages aside and renames into place, so a leftover staging directory from a
  // crashed attempt is discarded and the retry starts clean rather than adopting a partial
  // store. Simulated here by planting the staging directory a crash would have left.
  const resumed = join(fixture, 'resumed');
  await mkdir(join(resumed, 'project-store-v1.incoming'), { recursive: true });
  await writeFile(join(resumed, 'project-store-v1.incoming', 'half.json'), 'truncated');
  assert.deepEqual(
    await relocateDataDir(source, resumed, () => undefined, false),
    { copiedEntries: 2 },
  );
  assert.equal(
    await readFile(join(resumed, 'project-store-v1', 'projects.json'), 'utf8'),
    '[]',
    'the retry copies the real store, not the abandoned partial one',
  );
  assert.equal(
    existsSync(join(resumed, 'project-store-v1', 'half.json')),
    false,
    'nothing from the crashed attempt survives into the adopted store',
  );
  assert.equal(
    existsSync(join(resumed, 'project-store-v1.incoming')),
    false,
    'the staging directory is not left behind',
  );

  // 6. A second relocation into a populated destination overwrites nothing and says so.
  await writeFile(join(destination, 'deleted-projects-v1.json'), 'newer, must win');
  const again = await relocateDataDir(source, destination, (msg) => logs.push(msg), false);
  assert.deepEqual(again, { copiedEntries: 0 });
  assert.equal(await readFile(join(destination, 'deleted-projects-v1.json'), 'utf8'), 'newer, must win');
  assert.ok(logs.some((msg) => msg.includes('skipped')), 'a skipped entry is reported, never silent');

  // 7. Creating the root up front is idempotent, so a first run never races a first write.
  const eager = join(fixture, 'eager', 'nested');
  ensureDataDir(eager);
  ensureDataDir(eager);
  assert.ok(existsSync(eager));
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log('data-dir.verify OK');
