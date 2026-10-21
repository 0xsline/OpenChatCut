import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import { makeDraft } from '../editor/store.ts';
import type { ProjectDoc } from '../editor/types.ts';
import { ToolActivation } from './tool-activation.ts';
import { TOOL_SCHEMAS } from './tools.ts';
import { isFailedToolResult } from './toolFailure.ts';
import { ServerRunToolExecutor } from './serverRunToolExecutor.ts';
import { FakeLockManager, MemoryStorage } from './serverRunToolExecutor.verify-helpers.ts';
import { saveStoredServerRun } from './serverRunSessionStorage.ts';
import { PROJECT_SAVE_WARNING, projectWriteOutcome, withProjectSaveWarning } from './serverRunProjectWrite.ts';
import type { ServerRunProjectWrite } from './serverRunProtocol.ts';

const ops = (persistent: number, live: number) => ({ persistent, live });

// Only calls that add operations landing on the live project report a write at all:
// reads, web/code/export tools and proposal-only edits (auto-apply off) are `none`.
assert.equal(projectWriteOutcome(ops(0, 0), ops(0, 0), ops(0, 0)), 'none');
assert.equal(projectWriteOutcome(ops(1, 2), ops(1, 2), ops(1, 2)), 'none',
  'an earlier failed save never taints a call that adds no landing edits');
assert.equal(projectWriteOutcome(ops(0, 0), ops(1, 0), ops(0, 0)), 'saved');
assert.equal(projectWriteOutcome(ops(0, 0), ops(0, 1), ops(0, 0)), 'saved');
assert.equal(projectWriteOutcome(ops(0, 0), ops(0, 1), ops(0, 1)), 'queued');
assert.equal(projectWriteOutcome(ops(1, 0), ops(1, 1), ops(0, 1)), 'queued');
assert.equal(projectWriteOutcome(ops(0, 1), ops(1, 1), ops(0, 1)), 'saved',
  'a saved pool import is not blamed for timeline edits an earlier call left queued');

// A queued edit stays a success, so the model is not invited to repeat (and duplicate) it.
const annotated = withProjectSaveWarning({ ok: true, itemId: 'clip-1' }) as Record<string, unknown>;
assert.equal(annotated.itemId, 'clip-1');
assert.equal(annotated.projectSaveWarning, PROJECT_SAVE_WARNING);
assert.equal(isFailedToolResult(annotated), false);
assert.deepEqual(withProjectSaveWarning('done'), { result: 'done', projectSaveWarning: PROJECT_SAVE_WARNING });
assert.deepEqual(withProjectSaveWarning(undefined), { result: null, projectSaveWarning: PROJECT_SAVE_WARNING });

const projectId = 'project-write';
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'timeline-write',
  timelines: [{
    id: 'timeline-write',
    name: 'Project write',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    items: [],
    selectedId: null,
  }],
};
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });

async function postedResult(write: ServerRunProjectWrite | undefined): Promise<Record<string, unknown>> {
  const runId = `run-${write ?? 'unknown'}`;
  const draft = makeDraft(doc);
  assert(saveStoredServerRun(projectId, { projectId, runId, attempts: [] }));
  const executor = new ServerRunToolExecutor(projectId, {
    ctx: () => ({
      commands: draft.commands,
      getState: draft.getState,
      getDoc: draft.getDoc,
      getCreativeMode: () => null,
      templates: [],
      audio: [],
    }),
    settings: () => ({} as never),
    onToolAction: () => write,
    updateMessages: () => undefined,
    setLiveTool: () => undefined,
    retryStream: () => undefined,
    abandonRecovery: () => undefined,
  }, new FakeLockManager());
  executor.start({
    capability: 'test-run-capability',
    baseDoc: doc,
    activation: new ToolActivation(TOOL_SCHEMAS, []),
    runId,
    abort: new AbortController(),
    recovered: new Map(),
  });
  let body: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/tool-claim')) return Response.json({ claimed: true, outcome: 'claimed' });
    if (url.endsWith('/tool-result')) {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, outcome: 'accepted' });
    }
    throw new Error(`unexpected request: ${url}`);
  };
  assert.equal(await executor.handle(runId, `call-${runId}`, 'read_timeline', {}, `digest-${runId}`, () => true), true);
  assert(body, 'the tool result was posted');
  return body;
}

try {
  const queued = await postedResult('queued');
  assert.equal(queued.error, undefined, 'a queued edit is never reported as a tool failure');
  assert.equal((queued.result as Record<string, unknown>).projectSaveWarning, PROJECT_SAVE_WARNING);
  for (const write of ['saved', 'none', undefined] as const) {
    const posted = await postedResult(write);
    assert.equal(posted.error, undefined);
    assert.equal((posted.result as Record<string, unknown>).projectSaveWarning, undefined,
      `${write ?? 'no report'} leaves the result untouched`);
  }
} finally {
  globalThis.fetch = originalFetch;
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}

console.log('serverRunProjectWrite.verify: only this call\'s unsaved live edits are flagged, as a non-failing warning');
