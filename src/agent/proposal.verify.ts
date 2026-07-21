import assert from 'node:assert/strict';
import { projectReduce } from '../editor/reduce';
import type { ProjectDoc, Timeline } from '../editor/types';
import { buildOperation, compactOperations } from './proposal';

const denoise = (src: string | null) => buildOperation(
  'isolate_voice',
  { itemId: 'clip-1' },
  [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: src, strength: 10 }],
);

const compacted = compactOperations([
  denoise('/voice-a.m4a'),
  denoise(null),
  denoise('/voice-b.m4a'),
  denoise(null),
]);
assert.equal(compacted.length, 1);
assert.equal(compacted[0].callCount, 4);
assert.equal(compacted[0].actions.length, 4);
assert.equal(compacted[0].action, '人声隔离');
assert.equal(compacted[0].impact, '4 处改动');

const separated = compactOperations([
  denoise('/voice-a.m4a'),
  buildOperation('move_item', { itemId: 'clip-1' }, [{ type: 'move', id: 'clip-1', startFrame: 10 }]),
  denoise(null),
]);
assert.equal(separated.length, 3);

const timeline = { id: 'tl-1', name: 'Timeline', order: 0 } as Timeline;
const doc: ProjectDoc = {
  version: 2,
  assets: [],
  mediaFolders: [],
  timelines: [timeline],
  activeTimelineId: timeline.id,
};
assert.equal(projectReduce(doc, { type: 'tl.switch', id: timeline.id }), doc);

console.log('proposal compaction checks passed');
