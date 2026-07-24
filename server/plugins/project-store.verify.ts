import assert from 'node:assert/strict';
import { mergeProjectEntries } from './project-store';

const left = {
  projects: [{ id: 'a', name: 'Chrome Engineering', updatedAt: 10 }],
  'project:a': { marker: 'left' },
  'versions:a': [{ id: 'v1', createdAt: 1 }],
  'skills:custom': [{ id: 's1', createdAt: 1 }],
};
const right = {
  projects: [
    { id: 'b', name: 'Brave Engineering', updatedAt: 20 },
    { id: 'a', name: 'Updated project', updatedAt: 30 },
  ],
  'project:a': { marker: 'newer' },
  'project:b': { marker: 'right' },
  'versions:a': [{ id: 'v2', createdAt: 2 }],
  'skills:custom': [{ id: 's2', createdAt: 2 }],
};

const merged = mergeProjectEntries(left, right);
assert.deepEqual((merged.projects as Array<{ id: string }>).map((project) => project.id), ['a', 'b']);
assert.deepEqual(merged['project:a'], { marker: 'newer' });
assert.deepEqual(merged['project:b'], { marker: 'right' });
assert.deepEqual((merged['versions:a'] as Array<{ id: string }>).map((version) => version.id), ['v1', 'v2']);
assert.deepEqual((merged['skills:custom'] as Array<{ id: string }>).map((skill) => skill.id), ['s1', 's2']);

const older = mergeProjectEntries(merged, {
  projects: [{ id: 'a', name: 'old project', updatedAt: 5 }],
  'project:a': { marker: 'older' },
});
assert.deepEqual(older['project:a'], { marker: 'newer' });
assert.equal((older.projects as Array<{ name: string }>)[0].name, 'Updated project');

const afterPermanentDelete = mergeProjectEntries(merged, {
  projects: [{ id: 'a', name: 'An old copy from another browser', updatedAt: 40 }],
  'project:a': { marker: 'stale-browser' },
  'chat:a': { messages: ['stale'] },
  'versions:a': [{ id: 'v3', createdAt: 3 }],
}, new Set(['a']));
assert.deepEqual(
  (afterPermanentDelete.projects as Array<{ id: string }>).map((project) => project.id),
  ['b'],
  'Permanent deletion flag must prevent another browser from resurrecting the old project',
);
assert.ok(!('project:a' in afterPermanentDelete));
assert.ok(!('chat:a' in afterPermanentDelete));
assert.ok(!('versions:a' in afterPermanentDelete));

console.log('project-store.verify: ok');
