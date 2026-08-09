import assert from 'node:assert/strict';
import { kvDel, kvGet, kvRemoteMode, kvSet, resetSharedKvMemory } from './sharedKv';
import { resetProjectStoreTransport } from './projectStoreTransport';

resetProjectStoreTransport();
resetSharedKvMemory();

// Node memory fallback: reads/writes work locally, mode stays 'local'.
assert.equal(kvRemoteMode(), 'local', 'no remote session in Node → local mode');
await kvSet('k1', { a: 1 });
assert.deepEqual(await kvGet('k1'), { a: 1 }, 'local round-trip works');
await kvDel('k1');
assert.equal(await kvGet('k1'), undefined, 'local delete works');

// Project documents keep local semantics in the Node fallback (no IndexedDB):
// the shared-delete guard only fires for browser environments with IDB.
await kvSet('project:p1', { name: 'x' });
assert.equal(kvRemoteMode(), 'local');
await kvDel('project:p1');
assert.equal(await kvGet('project:p1'), undefined, 'Node fallback project delete stays local');

console.log('sharedKv.verify: local fallback semantics passed');
