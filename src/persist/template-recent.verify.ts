import assert from 'node:assert/strict';
import { pushRecentTemplateId } from './sessionPrefs';

const writes: Array<[string, string]> = [];
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: (key: string, value: string) => writes.push([key, value]),
    removeItem: () => undefined,
  },
});

const existing = ['template-a', 'template-b'];
const unchanged = pushRecentTemplateId('template-a', existing);
assert.equal(unchanged, existing, 'reusing a recent template should preserve list identity and card order');
assert.equal(writes.length, 0, 'an unchanged recent list should not rewrite storage');

const next = pushRecentTemplateId('template-c', existing);
assert.deepEqual(next, ['template-c', 'template-a', 'template-b']);
assert.notEqual(next, existing);
assert.equal(writes.length, 1);

console.log('template-recent.verify: repeated drags preserve recent template order');
