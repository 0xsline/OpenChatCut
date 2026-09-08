import assert from 'node:assert/strict';
import { localGet } from './sharedKvLocal';
import { idbGet } from './mediaBlobDatabase';
import { listPacks } from '../plugins/store';

// Fault injection covers both browser error callbacks and synchronous open
// failures. Native Chrome read/write recovery is also checked before merging.
const original = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
let failure: 'async' | 'sync' | null = null;
let opens = 0;
let database: IDBDatabase | undefined;
const error = new DOMException('database is temporarily unavailable', 'UnknownError');
const resultRequest = () => {
  const request = { result: undefined } as IDBRequest;
  queueMicrotask(() => request.onsuccess?.(new Event('success')));
  return request;
};
Object.defineProperty(globalThis, 'indexedDB', {
  configurable: true,
  value: {
    open() {
      opens += 1;
      if (failure === 'sync') throw error;
      const shouldFail = failure === 'async';
      database = {
        close() {},
        transaction: () => ({ objectStore: () => ({ get: resultRequest }) }),
      } as unknown as IDBDatabase;
      const request = { result: database, error } as IDBOpenDBRequest;
      queueMicrotask(() => {
        if (shouldFail) request.onerror?.(new Event('error'));
        else request.onsuccess?.(new Event('success'));
      });
      return request;
    },
  },
});

try {
  for (const [name, read] of [
    ['shared KV', () => localGet('connection-recovery')],
    ['media cache', () => idbGet('/media/uploads/connection-recovery')],
    ['legacy plugins', () => listPacks()],
  ] as const) {
    for (const kind of ['async', 'sync'] as const) {
      const before = opens;
      failure = kind;
      await read().catch(() => undefined);
      failure = null;
      await read();
      assert.equal(opens, before + 2, `${name}: ${kind} open failure must retry`);
      await read();
      assert.equal(opens, before + 2, `${name}: successful reads must reuse the connection`);
      assert.ok(database);
      database.onversionchange?.(new Event('versionchange') as IDBVersionChangeEvent);
    }
    await read();
    const beforeClose = opens;
    assert.ok(database);
    database.onclose?.(new Event('close'));
    await read();
    assert.equal(opens, beforeClose + 1, `${name}: forced close must reopen`);
    database.onversionchange?.(new Event('versionchange') as IDBVersionChangeEvent);
  }
} finally {
  if (original) Object.defineProperty(globalThis, 'indexedDB', original);
  else Reflect.deleteProperty(globalThis, 'indexedDB');
}
console.log('idbConnectionRecovery.verify: all three stores retry failed opens and reuse healthy connections');
