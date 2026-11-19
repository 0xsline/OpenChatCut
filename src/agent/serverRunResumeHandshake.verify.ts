import assert from 'node:assert/strict';
import {
  serverRunNeedsResume,
  serverRunRecoveryBlocked,
  serverRunResumeCursor,
  serverRunUnreconciledTools,
  type ServerRunMetadata,
} from './serverRunProtocol.ts';

/**
 * P4 — the resume handshake and the event baseline.
 *
 * These are the client-side decisions that must not be guessed: whether a stored
 * run needs the resume handshake or keeps the ordinary admission path, whether
 * it may start at all, and which cursor it is allowed to ask for after its
 * replay window has moved on.
 */

const admitted: ServerRunMetadata = {
  status: 'created',
  firstEventId: 1,
  lastEventId: 0,
  recovery: { state: 'admitted', revision: 0 },
};
assert.equal(
  serverRunNeedsResume(admitted),
  false,
  'a run the browser never started keeps the original admission path and its 60s deadline',
);

const ready: ServerRunMetadata = {
  status: 'running',
  firstEventId: 1,
  lastEventId: 12,
  recovery: { state: 'ready', revision: 5, tools: [] },
};
assert.equal(serverRunNeedsResume(ready), true, 'an ownerless recoverable run goes through the resume handshake');
assert.equal(serverRunNeedsResume({ ...ready, recovery: { state: 'active', revision: 5 } }), false,
  'a live executor streams directly and must not be trapped behind resume');
assert.equal(serverRunRecoveryBlocked(ready), false);

const waiting: ServerRunMetadata = {
  ...ready,
  recovery: {
    state: 'waiting_reconcile',
    revision: 6,
    tools: [
      { toolCallId: 'call-A', name: 'read_timeline', argsDigest: 'a', state: 'outcome', result: {} },
      { toolCallId: 'call-B', name: 'edit_item', argsDigest: 'b', state: 'claimed' },
    ],
  },
};
assert.equal(serverRunNeedsResume(waiting), true);
assert.equal(serverRunRecoveryBlocked(waiting), true, 'the durable phase itself can block a start');
assert.deepEqual(
  serverRunUnreconciledTools(waiting).map((tool) => tool.toolCallId),
  ['call-B'],
  'only tools without a durable outcome need reconciliation',
);

const finalized: ServerRunMetadata = {
  ...ready,
  recovery: { state: 'finalized', revision: 9, tools: [] },
};
assert.equal(
  serverRunNeedsResume(finalized),
  false,
  'a finalized run is never resumed; it takes the terminal path',
);

// Runs that never had a recovery row keep the old metadata shape.
assert.equal(serverRunNeedsResume({ status: 'running', firstEventId: 1, lastEventId: 3 }), false);
assert.deepEqual(serverRunUnreconciledTools({ status: 'running' }), []);

// --- cursor policy -------------------------------------------------------
const withBaseline: ServerRunMetadata = {
  ...ready,
  firstEventId: 40,
  lastEventId: 60,
  recovery: {
    state: 'ready',
    revision: 7,
    replayBase: {
      firstEventId: 40,
      lastEventId: 60,
      revision: 7,
      resetsCursor: true,
      terminalText: null,
    },
  },
};

const insideWindow = serverRunResumeCursor(withBaseline, 50);
assert.deepEqual(
  { cursor: insideWindow.cursor, adopted: insideWindow.adoptedBaseline },
  { cursor: 50, adopted: false },
  'a cursor still inside the window is used as-is',
);

const tooOld = serverRunResumeCursor(withBaseline, 10);
assert.equal(tooOld.adoptedBaseline, true);
assert.equal(tooOld.cursor, 60, 'an unreplayable cursor resumes at the baseline watermark');
assert.match(tooOld.reason ?? '', /超出可恢复窗口/);

const aheadOfServer = serverRunResumeCursor(withBaseline, 99);
assert.equal(aheadOfServer.adoptedBaseline, true);
assert.equal(
  aheadOfServer.cursor,
  60,
  'a cursor claiming events the server never wrote must not skip real work',
);
assert.match(aheadOfServer.reason ?? '', /超过了服务端水位/);

const boundary = serverRunResumeCursor(withBaseline, 39);
assert.equal(
  boundary.adoptedBaseline,
  false,
  'one event before firstEventId is still replayable (the server replays from firstEventId-1)',
);
assert.equal(serverRunResumeCursor(withBaseline, 38).adoptedBaseline, true);

// Without a published baseline nothing is invented.
const noBaseline = serverRunResumeCursor(ready, 999);
assert.deepEqual(
  { cursor: noBaseline.cursor, adopted: noBaseline.adoptedBaseline },
  { cursor: 999, adopted: false },
  'no baseline means no rewriting; the server answers with its own cursor error',
);

console.log('serverRunResumeHandshake.verify: resume-vs-admission, reconciliation gate, and baseline cursor policy passed');
