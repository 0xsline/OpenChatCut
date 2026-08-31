// Issue #125: stopping a run mid-tool and immediately starting the next one
// let the old tool's late completion read executor state the new run had
// overwritten — it posted /tool-result under the NEW run's capability (HTTP
// 403) and the stray permanent failure tore the new run down. The executor now
// snapshots an immutable per-run session; every continuation settles with its
// own authority or is dropped at a staleness fence. No locks: identity
// comparison only.
// npx tsx src/agent/serverRunToolExecutor.race.verify.ts
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import { makeDraft } from '../editor/store.ts';
import type { ProjectDoc } from '../editor/types.ts';
import { ToolActivation } from './tool-activation.ts';
import { TOOL_SCHEMAS } from './tools.ts';
import { ServerRunToolExecutor } from './serverRunToolExecutor.ts';
import { FakeLockManager, MemoryStorage } from './serverRunToolExecutor.verify-helpers.ts';
import { saveStoredServerRun } from './serverRunSessionStorage.ts';
import { SERVER_RUN_CAPABILITY_HEADER } from './serverRunProtocol.ts';
import { lifecycleRunFence } from './serverRunStreamLifecycle.ts';

const projectId = 'project-run-race';
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  activeTimelineId: 'timeline-race',
  timelines: [{
    id: 'timeline-race',
    name: 'Race',
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

interface SeenRequest {
  readonly url: string;
  readonly capability: string;
}

function makeExecutor(abandoned: string[]): ServerRunToolExecutor {
  return new ServerRunToolExecutor(projectId, {
    ctx: () => ({
      commands: draft.commands,
      getState: draft.getState,
      getDoc: draft.getDoc,
      getCreativeMode: () => null,
      templates: [],
      audio: [],
    }),
    settings: () => ({} as never),
    onToolAction: () => undefined,
    updateMessages: () => undefined,
    setLiveTool: () => undefined,
    retryStream: () => undefined,
    abandonRecovery: (runId) => { abandoned.push(runId); },
  }, new FakeLockManager());
}

const startInput = (runId: string, capability: string) => ({
  capability,
  baseDoc: doc,
  activation: new ToolActivation(TOOL_SCHEMAS, []),
  runId,
  abort: new AbortController(),
  recovered: new Map([['call-1', {
    name: 'read_project',
    argsDigest: 'digest-1',
    result: { ok: true },
  }]]),
});

try {
  assert(saveStoredServerRun(projectId, { projectId, runId: 'run-a', attempts: [] }));

  // ── a claim resolving after the next run started settles nothing ──────────
  {
    const abandoned: string[] = [];
    const executor = makeExecutor(abandoned);
    executor.start(startInput('run-a', 'cap-a'));

    const seen: SeenRequest[] = [];
    let releaseClaim: (() => void) | undefined;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      seen.push({ url, capability: headers[SERVER_RUN_CAPABILITY_HEADER] ?? '' });
      if (url.endsWith('/tool-claim')) {
        await new Promise<void>((resolve) => { releaseClaim = resolve; });
        return Response.json({ claimed: true, outcome: 'claimed' });
      }
      throw new Error(`unexpected request after supersession: ${url}`);
    };

    const handled = executor.handle('run-a', 'call-1', 'read_project', {}, 'digest-1', () => true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(releaseClaim, 'the claim must be in flight before the next run starts');

    // The user stops run A and sends the next task.
    executor.start(startInput('run-b', 'cap-b'));
    releaseClaim!();

    assert.equal(await handled, false, 'a superseded tool must not be handled');
    const results = seen.filter((r) => r.url.includes('/tool-result'));
    assert.deepEqual(results, [], 'a stale continuation must post no result at all');
    assert.deepEqual(abandoned, [], 'a dropped stale tool must not trigger recovery teardown');
  }

  // ── a result already in flight when the next run starts keeps its OWN
  //    authority — the defect was posting with the new run's capability ──────
  {
    const abandoned: string[] = [];
    const executor = makeExecutor(abandoned);
    executor.start(startInput('run-a', 'cap-a'));

    const resultCapabilities: string[] = [];
    let releaseResult: (() => void) | undefined;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/tool-claim')) {
        return Response.json({ claimed: true, outcome: 'claimed' });
      }
      const headers = init?.headers as Record<string, string>;
      resultCapabilities.push(headers[SERVER_RUN_CAPABILITY_HEADER] ?? '');
      assert.match(url, /run-a\/tool-result$/, 'the result settles against its own run');
      await new Promise<void>((resolve) => { releaseResult = resolve; });
      return Response.json({ ok: true, outcome: 'accepted' });
    };

    const handled = executor.handle('run-a', 'call-1', 'read_project', {}, 'digest-1', () => true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(releaseResult, 'the result post must be in flight');
    executor.start(startInput('run-b', 'cap-b'));
    releaseResult!();
    await handled;

    assert.deepEqual(resultCapabilities, ['cap-a'],
      'an in-flight result carries the OLD run\'s capability, never the new one');
  }

  // ── a request delivered under a stale runId never reaches the network ─────
  {
    const executor = makeExecutor([]);
    executor.start(startInput('run-b', 'cap-b'));
    globalThis.fetch = async (input) => {
      throw new Error(`stale-run request must not fetch: ${String(input)}`);
    };
    assert.equal(
      await executor.handle('run-a', 'call-9', 'read_project', {}, 'digest-9', () => true),
      false,
      'a superseded stream\'s request is rejected by runId',
    );
  }

  // ── over-fencing guard: an undisturbed run still completes ────────────────
  {
    const executor = makeExecutor([]);
    executor.start(startInput('run-a', 'cap-a'));
    let resultPosted = false;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith('/tool-claim')) return Response.json({ claimed: true, outcome: 'claimed' });
      resultPosted = true;
      return Response.json({ ok: true, outcome: 'accepted' });
    };
    assert.equal(
      await executor.handle('run-a', 'call-1', 'read_project', {}, 'digest-1', () => true),
      true,
      'the fences must not break the ordinary single-run path',
    );
    assert.ok(resultPosted, 'the recovered result is delivered');
  }

  // ── the lifecycle fence drops only callbacks from a FOREIGN active run ────
  {
    assert.equal(lifecycleRunFence('run-b', 'run-a'), false,
      'a late failure from a superseded run must not tear down the active one');
    assert.equal(lifecycleRunFence('run-a', 'run-a'), true,
      'the active run\'s own failure proceeds');
    assert.equal(lifecycleRunFence(null, 'run-a'), true,
      'with no active run, stored-run cleanup proceeds (pre-adoption recovery failure)');
  }
} finally {
  globalThis.fetch = originalFetch;
  if (storageDescriptor) Object.defineProperty(globalThis, 'localStorage', storageDescriptor);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
}

console.log('serverRunToolExecutor.race.verify: a superseded run cannot borrow the next run\'s authority');
