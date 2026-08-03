import assert from 'node:assert/strict';
import { ExportFailureError } from '../../src/export/exportFailure';
import { acceptExportSubmission } from './export-submission';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';

let acceptedCount = 0;
const state = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [{
    id: 'missing-video',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 30,
    name: 'Missing video',
    kind: 'video' as const,
    src: '/media/uploads/does-not-exist.mp4',
  }],
};
const admissionAbort = new AbortController();
const admissionAbortReason = new DOMException('request disconnected during admission', 'AbortError');
admissionAbort.abort(admissionAbortReason);
let abortedAdmissionFetches = 0;
await assert.rejects(
  () => acceptExportSubmission({
    state: {
      ...state,
      items: [{ ...state.items[0], src: 'https://media.example/expensive.mp4' }],
    },
  }, {
    signal: admissionAbort.signal,
    fetcher: async () => {
      abortedAdmissionFetches += 1;
      return new Response(Uint8Array.of(1));
    },
  }),
  (error: unknown) => error === admissionAbortReason,
);
assert.equal(abortedAdmissionFetches, 0, 'an already disconnected admission must not start materialization');


await assert.rejects(
  () => acceptExportSubmission({ state }),
  (error: unknown) => error instanceof ExportFailureError
    && error.failure.stage === 'preflight'
    && error.failure.mediaIssues?.[0]?.itemId === 'missing-video',
);
assert.equal(acceptedCount, 0, 'server media preflight must complete before acceptance');

const sequenceRoot = {
  id: 'root',
  name: 'Root',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  items: [{
    id: 'missing-sequence',
    track: 'V1',
    startFrame: 0,
    durationInFrames: 30,
    name: 'Missing sequence',
    kind: 'sequence' as const,
    timelineId: 'does-not-exist',
  }],
};
await assert.rejects(
  () => acceptExportSubmission({
    state: sequenceRoot,
    project: {
      version: CURRENT_PROJECT_VERSION,
      assets: [],
      mediaFolders: [],
      timelines: [sequenceRoot],
      activeTimelineId: sequenceRoot.id,
    },
    timelineId: sequenceRoot.id,
  }),
  (error: unknown) => error instanceof ExportFailureError
    && error.failure.stage === 'preflight'
    && error.failure.code === 'SEQUENCE_TIMELINE_MISSING'
    && error.failure.itemId === 'missing-sequence'
    && error.failure.timelineId === 'root'
    && error.failure.referencedTimelineId === 'does-not-exist'
    && error.failure.path?.includes('root') === true,
);
assert.equal(acceptedCount, 0, 'invalid sequence graphs must fail before acceptance');

const mismatchedFpsChild = {
  ...sequenceRoot,
  id: 'fps-child',
  name: '30fps child',
  order: 1,
  fps: 30,
  items: [],
};
const mismatchedFpsRoot = {
  ...sequenceRoot,
  id: 'fps-parent',
  name: '24fps parent',
  fps: 24,
  items: [{
    ...sequenceRoot.items[0],
    id: 'fps-mismatch-sequence',
    name: 'Mismatched sequence',
    timelineId: mismatchedFpsChild.id,
  }],
};
await assert.rejects(
  () => acceptExportSubmission({
    state: mismatchedFpsRoot,
    project: {
      version: CURRENT_PROJECT_VERSION,
      assets: [],
      mediaFolders: [],
      timelines: [mismatchedFpsRoot, mismatchedFpsChild],
      activeTimelineId: mismatchedFpsRoot.id,
    },
    timelineId: mismatchedFpsRoot.id,
  }),
  (error: unknown) => error instanceof ExportFailureError
    && error.failure.stage === 'preflight'
    && error.failure.code === 'SEQUENCE_FPS_MISMATCH'
    && error.failure.timelineId === mismatchedFpsRoot.id
    && error.failure.referencedTimelineId === mismatchedFpsChild.id
    && error.failure.parentFps === 24
    && error.failure.childFps === 30,
);
assert.equal(acceptedCount, 0, 'fps-mismatched sequence exports must fail before acceptance');

const sameFpsChild = {
  ...mismatchedFpsChild,
  id: 'same-fps-child',
};
const sameFpsRoot = {
  ...mismatchedFpsRoot,
  id: 'same-fps-parent',
  name: '30fps parent',
  fps: 30,
  items: [{
    ...mismatchedFpsRoot.items[0],
    id: 'same-fps-sequence',
    timelineId: sameFpsChild.id,
    startFrame: 40,
    durationInFrames: 120,
  }],
};
const sameFpsSubmission = await acceptExportSubmission({
  state: sameFpsRoot,
  project: {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    timelines: [sameFpsRoot, sameFpsChild],
    activeTimelineId: sameFpsRoot.id,
  },
  timelineId: sameFpsRoot.id,
});
acceptedCount += 1;
assert.equal(acceptedCount, 1, 'same-fps sequence export should be accepted');
assert.equal(sameFpsSubmission.plan.totalFrames, 160, 'same-fps export duration keeps the placed freeze tail');
await sameFpsSubmission.cleanup();

const accepted = await acceptExportSubmission({
  state: {
    ...state,
    items: [{ ...state.items[0], id: 'inline-video', src: 'data:video/mp4;base64,AA==' }],
  },
});
acceptedCount += 1;
assert.equal(accepted.plan.state.items[0]?.src, 'data:video/mp4;base64,AA==');
assert.equal(acceptedCount, 2);
await accepted.cleanup();

console.log('export submission preflight verification passed');
