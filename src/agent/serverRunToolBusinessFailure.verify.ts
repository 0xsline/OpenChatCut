import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import { makeDraft } from '../editor/store.ts';
import type { ProjectDoc } from '../editor/types.ts';
import { ToolActivation } from './tool-activation.ts';
import { TOOL_SCHEMAS } from './tools.ts';
import { ServerRunToolExecutor } from './serverRunToolExecutor.ts';
import { FakeLockManager, MemoryStorage } from './serverRunToolExecutor.verify-helpers.ts';
import { saveStoredServerRun } from './serverRunSessionStorage.ts';

const projectId = 'project-business-failure';
const runId = 'run-business-failure';
const toolCallId = 'call-business-failure';
const argsDigest = 'digest-business-failure';
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'timeline-business-failure',
  timelines: [{
    id: 'timeline-business-failure',
    name: 'Business failure',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    items: [],
    selectedId: null,
  }],
};
const draft = makeDraft(doc);
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'localStorage', {
  value: new MemoryStorage(),
  configurable: true,
});

try {
  assert(saveStoredServerRun(projectId, { projectId, runId, attempts: [] }));
  const actions: Array<{ error?: string; result?: unknown }> = [];
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
    onToolAction: (action) => { actions.push(action); },
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
  let resultBody: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/tool-claim')) {
      return Response.json({ claimed: true, outcome: 'claimed' });
    }
    if (url.endsWith('/tool-result')) {
      resultBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ok: true, outcome: 'accepted' });
    }
    throw new Error(`unexpected request: ${url}`);
  };

  assert.equal(await executor.handle(
    runId,
    toolCallId,
    'add_audio',
    {},
    argsDigest,
    () => true,
  ), true);
  const posted = resultBody as unknown as Record<string, unknown>;
  assert.match(String(posted.error), /audioName/);
  assert.equal(posted.result, undefined,
    'browser settlement omits the success result field for business failures');
  assert.match(String(actions[0]?.error), /audioName/,
    'durable recovery stores the business failure on its error channel');
  assert.equal(actions[0]?.result, undefined);
} finally {
  globalThis.fetch = originalFetch;
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else Reflect.deleteProperty(globalThis, 'localStorage');
}

console.log('server run browser business-failure verification passed');
