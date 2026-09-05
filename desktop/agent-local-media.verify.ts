import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedKeystore } from '../server/keystore.ts';
import { browseLocalMedia } from './agent-local-media.ts';
import { resolveAgentMediaPath } from './agent-path-import.ts';
import { isAgentLocalMediaRequest } from '../shared/agent-local-media.ts';

const fixture = await mkdtemp(join(tmpdir(), 'occ-local-media-'));
const root = await realpath(fixture);
try {
  seedKeystore({ AGENT_IMPORT_ROOTS: '' });
  await mkdir(join(root, 'Interview'));
  await writeFile(join(root, 'A.MP4'), 'media listing does not decode bytes');
  await writeFile(join(root, 'B.wav'), 'audio');
  await writeFile(join(root, 'notes.md'), 'not a media asset');
  await writeFile(join(root, 'Interview', 'take.mov'), 'video');
  const first = await browseLocalMedia({ path: root, limit: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.name), ['A.MP4', 'B.wav']);
  assert.equal(first.nextOffset, 2);
  assert.equal(first.truncated, false);
  assert.equal(first.errors.length, 0);
  const second = await browseLocalMedia({ path: root, limit: 2, offset: first.nextOffset });
  assert.deepEqual(second.entries.map((entry) => entry.kind), ['directory']);
  assert.equal(second.nextOffset, null);
  const search = await browseLocalMedia({ path: root, recursive: true, query: 'INTERVIEW', kind: 'video' });
  assert.deepEqual(search.entries.map((entry) => entry.path), [join(root, 'Interview', 'take.mov')]);
  assert.equal(search.entries[0]?.size, 5);
  assert.equal((await browseLocalMedia({ path: root, query: 'missing' })).entries.length, 0);
  await assert.rejects(browseLocalMedia({ path: join(root, 'missing') }), /ENOENT/);
  await assert.rejects(browseLocalMedia({ path: join(root, 'A.MP4') }), /ENOTDIR/);
  await assert.rejects(browseLocalMedia({ path: '../relative' }), /absolute/);
  for (const value of [null, [], { limit: 0 }, { limit: 201 }, { offset: -1 }, { recursive: 'yes' }, { kind: 'document' }]) {
    assert.equal(isAgentLocalMediaRequest(value), false);
    await assert.rejects(browseLocalMedia(value), /invalid/);
  }
  assert.equal(await resolveAgentMediaPath(root), root, 'no roots means local access by default');
  let deep = join(root, 'deep');
  for (let depth = 0; depth < 14; depth += 1) { await mkdir(deep); deep = join(deep, 'next'); }
  assert.equal((await browseLocalMedia({ path: root, recursive: true })).truncated, true);

  seedKeystore({ AGENT_IMPORT_ROOTS: join(root, 'Interview') });
  await assert.rejects(browseLocalMedia({ path: root }), /已添加的目录/);
  assert.equal((await browseLocalMedia({ path: join(root, 'Interview') })).entries.length, 1);
  if (process.platform !== 'win32') {
    await symlink(root, join(root, 'Interview', 'escape'), 'dir');
    await assert.rejects(browseLocalMedia({ path: join(root, 'Interview', 'escape') }), /已添加的目录/);
    const nested = await browseLocalMedia({ path: join(root, 'Interview'), recursive: true });
    assert.equal(nested.entries.length, 1, 'recursive scan does not follow symlink cycles');
    const alias = join(root, 'alias');
    await symlink(join(root, 'Interview'), alias, 'dir');
    seedKeystore({ AGENT_IMPORT_ROOTS: alias });
    assert.equal((await browseLocalMedia({ path: alias, recursive: true })).entries.length, 1,
      'explicit symlink roots remain browsable after canonicalization');
  }
  seedKeystore({ AGENT_IMPORT_ROOTS: join(root, 'missing-root') });
  await assert.rejects(resolveAgentMediaPath(join(root, 'A.MP4')), /已添加的目录/);
} finally {
  seedKeystore({ AGENT_IMPORT_ROOTS: '' });
  await rm(fixture, { recursive: true, force: true });
}
console.log('agent-local-media.verify: default access, search, pagination, bounds and explicit restrictions passed');
