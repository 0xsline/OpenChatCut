// Runnable check: `npx tsx src/editor/sequenceGraph.verify.ts`
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.js';
import { runProjectMigrations } from '../persist/migrations';
import { projectReduce, reduce } from './reduce';
import {
  DEFAULT_SEQUENCE_GRAPH_LIMITS,
  nestedSequenceFrom,
  resolveTimelineRenderPlan,
  sequenceGraphError,
  sequenceItemDuration,
  sequenceReferenceError,
  validateSequenceGraph,
} from './sequenceGraph';
import {
  sourceFrameAt,
  sourceFramesToTimelineFrames,
  sourceWindowForTimelineRange,
  timelineFramesToSourceFrames,
} from './sourceLimit';
import type { MediaAsset, ProjectDoc, Timeline, TimelineItem } from './types';

const media = (
  id: string,
  kind: 'video' | 'audio' | 'image',
  src: string,
  startFrame: number,
  durationInFrames: number,
): TimelineItem => ({ id, kind, src, name: id, track: kind === 'audio' ? 'A1' : 'V1', startFrame, durationInFrames });

const sequence = (
  id: string,
  timelineId: string,
  startFrame: number,
  durationInFrames: number,
  srcInFrame = 0,
  playbackRate = 1,
): TimelineItem => ({
  id,
  kind: 'sequence',
  timelineId,
  name: id,
  track: 'V1',
  startFrame,
  durationInFrames,
  srcInFrame,
  playbackRate,
});

const timeline = (id: string, items: TimelineItem[], order = 0, fps = 30): Timeline => ({
  id,
  name: id,
  order,
  fps,
  width: 1920,
  height: 1080,
  items,
  selectedId: null,
});

const assets: MediaAsset[] = [
  { id: 'asset-root', name: 'root', kind: 'image', src: '/root.png', durationInFrames: 30 },
  { id: 'asset-middle', name: 'middle', kind: 'audio', src: '/middle.wav', durationInFrames: 30 },
  { id: 'asset-leaf', name: 'leaf', kind: 'video', src: '/leaf.mp4', durationInFrames: 120 },
];

const leaf = timeline('leaf', [media('leaf-video', 'video', '/leaf.mp4', 0, 120)], 2);
const middle = timeline('middle', [
  media('middle-audio', 'audio', '/middle.wav', 0, 30),
  sequence('middle-leaf', 'leaf', 10, 80, 20, 2),
], 1);
const root = timeline('root', [
  media('root-image', 'image', '/root.png', 0, 30),
  sequence('root-middle', 'middle', 5, 100, 0, 0.5),
]);
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets,
  mediaFolders: [],
  timelines: [root, middle, leaf],
  activeTimelineId: root.id,
};

// Multi-level traversal uses the same source-frame mapping as playback and aggregates dependencies once.
validateSequenceGraph(doc);
const plan = resolveTimelineRenderPlan(doc, root.id);
assert.equal(plan.durationInFrames, 105);
assert.equal(plan.nodeCount, 3);
assert.deepEqual(new Set(plan.timelineIds), new Set(['root', 'middle', 'leaf']));
assert.deepEqual(new Set(plan.assetIds), new Set(['asset-root', 'asset-middle', 'asset-leaf']));
assert.deepEqual(new Set(plan.sources), new Set(['/root.png', '/middle.wav', '/leaf.mp4']));

// A descendant that runs out of source freezes its last frame without shortening either placed sequence.
const shorterLeaf = timeline('leaf', [media('leaf-video', 'video', '/leaf.mp4', 0, 50)], 2);
const shorterDoc = { ...doc, timelines: [root, middle, shorterLeaf] };
assert.equal(resolveTimelineRenderPlan(shorterDoc, root.id).durationInFrames, 105);
assert.equal(resolveTimelineRenderPlan(shorterDoc, middle.id).durationInFrames, 90);

// Preview placement and export duration retain the full retimed tail after the child source is exhausted.
const freezeChild = timeline('freeze-child', [media('freeze-source', 'video', '/leaf.mp4', 0, 30)], 1);
const freezeItem = sequence('retimed-freeze', freezeChild.id, 40, 120, 20, 2);
const freezeRoot = timeline('freeze-root', [freezeItem]);
const freezeDoc: ProjectDoc = {
  ...doc,
  timelines: [freezeRoot, freezeChild],
  activeTimelineId: freezeRoot.id,
};
const freezeWindow = sourceWindowForTimelineRange(freezeItem, 0, freezeItem.durationInFrames);
assert.ok(freezeWindow.endFrame > resolveTimelineRenderPlan(freezeDoc, freezeChild.id).durationInFrames);
assert.equal(
  resolveTimelineRenderPlan(freezeDoc, freezeRoot.id).durationInFrames,
  freezeItem.startFrame + freezeItem.durationInFrames,
);
assert.equal(sequenceItemDuration(freezeDoc, freezeItem), freezeItem.durationInFrames);

// Parent and child timelines must share an fps before add, preview planning, or reducer commit.
const fps24 = timeline('fps-24', [], 0, 24);
const fps30 = timeline('fps-30', [], 1, 30);
const fps24Doc: ProjectDoc = {
  ...doc,
  timelines: [fps24, fps30],
  activeTimelineId: fps24.id,
};
const add24To30Error = sequenceReferenceError(fps24Doc, fps24.id, fps30.id);
assert.equal(add24To30Error?.code, 'SEQUENCE_FPS_MISMATCH');
assert.equal(add24To30Error?.timelineId, fps24.id);
assert.equal(add24To30Error?.referencedTimelineId, fps30.id);
assert.equal(add24To30Error?.parentFps, 24);
assert.equal(add24To30Error?.childFps, 30);
const fps30Doc: ProjectDoc = {
  ...fps24Doc,
  activeTimelineId: fps30.id,
};
const add30To24Error = sequenceReferenceError(fps30Doc, fps30.id, fps24.id);
assert.equal(add30To24Error?.code, 'SEQUENCE_FPS_MISMATCH');
assert.equal(add30To24Error?.parentFps, 30);
assert.equal(add30To24Error?.childFps, 24);
const fpsMismatchItem = sequence('fps-mismatch-item', fps30.id, 0, 60);
const mismatchedParent = { ...fps24, items: [fpsMismatchItem] };
const mismatchedDoc: ProjectDoc = {
  ...fps24Doc,
  timelines: [mismatchedParent, fps30],
};
const existingFpsError = sequenceGraphError(mismatchedDoc);
assert.equal(existingFpsError?.code, 'SEQUENCE_FPS_MISMATCH');
assert.notEqual(existingFpsError?.code, 'SEQUENCE_CYCLE');
assert.notEqual(existingFpsError?.code, 'SEQUENCE_DEPTH_LIMIT');
assert.deepEqual(existingFpsError?.path, [fps24.id, fps30.id]);
assert.equal(
  projectReduce(fps24Doc, { type: 'add', item: fpsMismatchItem, startFrame: 0 }),
  fps24Doc,
  '24fps parent state must not change when adding a 30fps child',
);
const reverseMismatchItem = sequence('reverse-fps-mismatch-item', fps24.id, 0, 60);
assert.equal(
  projectReduce(fps30Doc, { type: 'add', item: reverseMismatchItem, startFrame: 0 }),
  fps30Doc,
  '30fps parent state must not change when adding a 24fps child',
);
assert.throws(
  () => resolveTimelineRenderPlan(mismatchedDoc, mismatchedParent.id),
  (error: unknown) => error instanceof Error
    && 'code' in error
    && error.code === 'SEQUENCE_FPS_MISMATCH'
    && 'parentFps' in error
    && error.parentFps === 24
    && 'childFps' in error
    && error.childFps === 30,
);

// Same-fps references keep the placed duration and freeze-tail behavior unchanged.
const sameFpsChild = timeline('same-fps-child', [media('same-fps-source', 'video', '/leaf.mp4', 0, 30)], 1, 30);
const sameFpsItem = sequence('same-fps-item', sameFpsChild.id, 40, 120, 20, 2);
const sameFpsParent = timeline('same-fps-parent', [sameFpsItem], 0, 30);
const sameFpsDoc: ProjectDoc = {
  ...doc,
  timelines: [sameFpsParent, sameFpsChild],
  activeTimelineId: sameFpsParent.id,
};
validateSequenceGraph(sameFpsDoc);
assert.equal(sequenceReferenceError(sameFpsDoc, sameFpsParent.id, sameFpsChild.id), null);
assert.equal(resolveTimelineRenderPlan(sameFpsDoc, sameFpsParent.id).durationInFrames, 160);
assert.equal(sequenceItemDuration(sameFpsDoc, sameFpsItem), 120);

// One-ULP-equivalent numeric fps values are accepted, but nominally different rates are not.
const normalizedParent = timeline('normalized-parent', [sequence('normalized-edge', 'normalized-child', 0, 1)], 0, 0.1 + 0.2);
const normalizedChild = timeline('normalized-child', [], 1, 0.3);
assert.equal(sequenceGraphError({
  timelines: [normalizedParent, normalizedChild],
}), null);

// Seek/source-window math preserves fractional positions and speed in both directions.
const seekItem = sequence('seek', 'leaf', 0, 100, 12, 1.5);
assert.equal(sourceFrameAt(seekItem, 20), 42);
assert.equal(timelineFramesToSourceFrames(seekItem, 20), 30);
assert.equal(sourceFramesToTimelineFrames(seekItem, 30), 20);
assert.deepEqual(sourceWindowForTimelineRange(seekItem, 5, 10), { startFrame: 19.5, endFrame: 34.5 });

// Incoming-transition pre-roll must not shift a nested sequence's mapped source frame.
const transitionItem = sequence('transition-sequence', 'leaf', 0, 90, 12, 1.5);
const transitionPreRoll = 6;
for (const parentFrame of [0, transitionPreRoll, 30]) {
  const localFrame = parentFrame - transitionPreRoll;
  const sourceFrame = sourceFrameAt(transitionItem, localFrame);
  const dynamicFrom = nestedSequenceFrom(parentFrame, sourceFrame);
  assert.equal(
    parentFrame - dynamicFrom,
    sourceFrame,
    'nested sequence child time must equal its source mapping throughout transition pre-roll',
  );
}

// Missing, direct/self, and indirect cycles are rejected before render/commit.
const missingDoc = { ...doc, timelines: [timeline('root', [sequence('bad', 'gone', 0, 30)])] };
assert.equal(sequenceGraphError(missingDoc)?.code, 'SEQUENCE_TIMELINE_MISSING');
assert.equal(sequenceReferenceError(doc, root.id, root.id)?.code, 'SEQUENCE_CYCLE');
const selfCycleDoc: ProjectDoc = {
  ...doc,
  timelines: [timeline('self', [sequence('self-reference', 'self', 0, 30)])],
  activeTimelineId: 'self',
};
const selfCycleError = sequenceGraphError(selfCycleDoc, { maxDepth: 1 });
assert.equal(selfCycleError?.code, 'SEQUENCE_CYCLE');
assert.equal(selfCycleError?.itemId, 'self-reference');
const cyclicDoc = {
  ...doc,
  timelines: [timeline('a', [sequence('a-b', 'b', 0, 30)]), timeline('b', [sequence('b-a', 'a', 0, 30)], 1)],
  activeTimelineId: 'a',
};
assert.deepEqual(sequenceGraphError(cyclicDoc)?.path, ['a', 'b', 'a']);

// A shared child reached first through a shallow edge still fails when another instance exceeds the path depth.
const depthShared = timeline('depth-shared', []);
const depthMiddle = timeline('depth-middle', [sequence('depth-middle-shared', depthShared.id, 0, 30)], 2);
const depthBranch = timeline('depth-branch', [sequence('depth-branch-middle', depthMiddle.id, 0, 30)], 1);
const depthRoot = timeline('depth-root', [
  sequence('depth-shallow-first', depthShared.id, 0, 30),
  sequence('depth-deep-second', depthBranch.id, 30, 30),
]);
const depthDoc: ProjectDoc = {
  ...doc,
  timelines: [depthRoot, depthBranch, depthMiddle, depthShared],
  activeTimelineId: depthRoot.id,
};
const depthError = sequenceGraphError(depthDoc, { maxDepth: 3, maxNodes: 16 });
assert.equal(depthError?.code, 'SEQUENCE_DEPTH_LIMIT');
assert.deepEqual(depthError?.path, ['depth-root', 'depth-branch', 'depth-middle', 'depth-shared']);

// A legal DAG reuses its leaf without becoming a cycle, and validation/resolve consume identical per-root budgets.
const dagLeft = timeline('dag-left', [sequence('dag-left-leaf', leaf.id, 0, 30)], 1);
const dagRight = timeline('dag-right', [sequence('dag-right-leaf', leaf.id, 0, 30)], 2);
const dagRoot = timeline('dag-root', [
  sequence('dag-left-instance', dagLeft.id, 0, 30),
  sequence('dag-right-instance', dagRight.id, 30, 30),
]);
const dagDoc: ProjectDoc = {
  ...doc,
  timelines: [dagRoot, dagLeft, dagRight, leaf],
  activeTimelineId: dagRoot.id,
};
const dagLimits = { maxDepth: 3, maxNodes: 5 };
validateSequenceGraph(dagDoc, dagLimits);
for (const candidate of dagDoc.timelines) {
  assert.doesNotThrow(() => resolveTimelineRenderPlan(dagDoc, candidate.id, dagLimits));
}
const dagPlan = resolveTimelineRenderPlan(dagDoc, dagRoot.id, dagLimits);
assert.equal(dagPlan.nodeCount, 5);
assert.deepEqual(new Set(dagPlan.timelineIds), new Set([dagRoot.id, dagLeft.id, dagRight.id, leaf.id]));
assert.equal(sequenceGraphError(dagDoc, { ...dagLimits, maxNodes: 4 })?.code, 'SEQUENCE_NODE_LIMIT');

// Thousands of repeated sequence instances exhaust the default render-instance budget before reducer commit.
const repeatedRoot = timeline(
  'repeated-root',
  Array.from({ length: DEFAULT_SEQUENCE_GRAPH_LIMITS.maxNodes }, (_, index) =>
    sequence(`repeated-${index}`, leaf.id, index, 1)),
);
const repeatedDoc: ProjectDoc = {
  ...doc,
  timelines: [repeatedRoot, leaf],
  activeTimelineId: repeatedRoot.id,
};
const repeatedError = sequenceGraphError(repeatedDoc);
assert.equal(repeatedError?.code, 'SEQUENCE_NODE_LIMIT');
assert.equal(repeatedError?.limit, DEFAULT_SEQUENCE_GRAPH_LIMITS.maxNodes);
assert.deepEqual(repeatedError?.path, [repeatedRoot.id, leaf.id]);
assert.equal(projectReduce(doc, { type: 'tl.setDoc', doc: repeatedDoc }), doc);
assert.throws(
  () => resolveTimelineRenderPlan(repeatedDoc, repeatedRoot.id),
  (error: unknown) => error instanceof Error && 'code' in error && error.code === 'SEQUENCE_NODE_LIMIT',
);

// Duplicating an instance creates a new item id without copying or changing the child timeline.
const duplicated = reduce(root, { type: 'duplicate', id: 'root-middle', newId: 'root-middle-copy' });
const originalInstance = duplicated.items.find((item) => item.id === 'root-middle');
const copiedInstance = duplicated.items.find((item) => item.id === 'root-middle-copy');
assert.equal(originalInstance?.timelineId, 'middle');
assert.equal(copiedInstance?.timelineId, 'middle');
assert.notEqual(originalInstance?.id, copiedInstance?.id);
assert.equal(doc.timelines.length, 3);

// Referenced timelines cannot be deleted, and invalid graph replacements/additions never enter project history.
assert.equal(projectReduce(doc, { type: 'tl.delete', id: 'middle' }), doc);
assert.equal(projectReduce(doc, { type: 'tl.setDoc', doc: cyclicDoc }), doc);
assert.equal(projectReduce(doc, {
  type: 'add',
  item: sequence('missing-instance', 'gone', 0, 30),
  startFrame: 0,
}), doc);

// Current sequence documents migrate, while old projects without sequence fields stay readable.
assert.equal(runProjectMigrations(doc)?.doc.timelines[0]?.items[1]?.timelineId, 'middle');
const legacyDoc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  timelines: [timeline('legacy', [media('legacy-video', 'video', '/legacy.mp4', 0, 30)])],
  activeTimelineId: 'legacy',
};
const migratedLegacy = runProjectMigrations(legacyDoc)?.doc;
assert.equal(migratedLegacy?.timelines[0]?.items[0]?.kind, 'video');
assert.equal(migratedLegacy?.timelines[0]?.items[0]?.timelineId, undefined);

console.log('sequenceGraph.verify.ts: ok');
