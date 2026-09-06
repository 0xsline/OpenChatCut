import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import assert from 'node:assert/strict';
import { projectReduce } from '../editor/reduce';
import { makeDraft } from '../editor/store';
import {
  parseProposal,
  parseStoredProposalRecord,
} from '../persist/proposalStore';
import type { ProjectDoc, Timeline } from '../editor/types';
import { canRollbackAgentChange, rollbackAgentChange, type AgentChangeSession } from './changeLog';
import { buildOperation, buildProposal, compactOperations, type Proposal } from './proposal';
import {
  applySelectedProposal,
  rejectPendingProposal,
  type ProposalPersistence,
} from './useAgentProposalActions';
import {
  commitPersistentOperations,
  createPendingProposal,
  statusAfterMaxToolTurns,
  type AgentTurn,
} from './useAgentRun';
import type { AgentHookState } from './useAgentState';
import type { ProjectSaveResult } from '../persist/projectStoreCoordinators';

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

const distinctArguments = compactOperations([
  buildOperation('edit_captions', { itemId: 'clip-1', text: 'First' }, [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: '/first.m4a', strength: 10 }]),
  buildOperation('edit_captions', { text: 'Second', itemId: 'clip-1' }, [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: '/second.m4a', strength: 10 }]),
]);
assert.equal(distinctArguments.length, 2, 'different edits to one target must remain separately reviewable');

const reorderedArguments = compactOperations([
  buildOperation('edit_captions', { itemId: 'clip-1', text: 'Same' }, [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: '/first.m4a', strength: 10 }]),
  buildOperation('edit_captions', { text: 'Same', itemId: 'clip-1' }, [{ type: 'setItemDenoise', id: 'clip-1', denoisedSrc: '/second.m4a', strength: 10 }]),
]);
assert.equal(reorderedArguments.length, 1, 'argument key order must not prevent duplicate compaction');

const separated = compactOperations([
  denoise('/voice-a.m4a'),
  buildOperation('move_item', { itemId: 'clip-1' }, [{ type: 'move', id: 'clip-1', startFrame: 10 }]),
  denoise(null),
]);
assert.equal(separated.length, 3);

const timeline = {
  id: 'tl-1',
  name: 'Timeline',
  order: 0,
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
} as Timeline;
const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  timelines: [timeline],
  activeTimelineId: timeline.id,
};

function saveResult(saved: boolean): ProjectSaveResult {
  return {
    projectId: 'proposal-persistence-verify',
    revision: 1,
    epoch: 1,
    status: saved ? 'saved' : 'failed',
    saved,
    indexUpdated: saved,
  };
}
function proposalPersistence(
  order: string[],
  overrides: Partial<ProposalPersistence> = {},
): ProposalPersistence {
  return {
    saveVersion: async () => { order.push('version'); return null; },
    saveDoc: async () => { order.push('save'); return saveResult(true); },
    markApplying: async () => { order.push('applying'); },
    settle: async (_projectId, _proposal, outcome) => { order.push(`settle-${outcome}`); },
    clear: async () => { order.push('durable-clear'); },
    ...overrides,
  };
}


function proposalState(
  proposal: Proposal,
  order: string[],
  errors: string[],
): AgentHookState {
  let currentDoc = doc;
  const state = {
    proposalRef: { current: proposal },
    applyingProposalRef: { current: false },
    ctxRef: {
      current: {
        getDoc: () => currentDoc,
        commands: {
          applyDoc: (next: ProjectDoc) => {
            order.push('apply');
            currentDoc = next;
          },
        },
      },
    },
    setProposalStale: () => undefined,
    setMessages: (update: (current: Array<{ role: string; text: string }>) => Array<{ role: string; text: string }>) => {
      errors.push(...update([]).filter((message) => message.role === 'error').map((message) => message.text));
    },
    setChangeLog: () => undefined,
    llmRef: { current: [] },
    refreshEstimatedContextUsage: () => undefined,
    setProposal: (next: Proposal | null) => { if (next === null) order.push('clear'); },
  };
  return state as unknown as AgentHookState;
}

async function verifyProposalPersistenceFence(): Promise<void> {
  const operation = buildOperation(
    'rename_timeline',
    { timelineId: timeline.id, name: 'Renamed' },
    [{ type: 'tl.rename', id: timeline.id, name: 'Renamed' }],
  );
  const proposal = buildProposal(
    [operation], 'Rename timeline', doc, { fps: 30, items: [] } as never,
  );
  const order: string[] = [];
  const errors: string[] = [];
  const state = proposalState(proposal, order, errors);
  const persistence = proposalPersistence(order);
  await applySelectedProposal(state, 'proposal-persistence-verify', new Set([0]), persistence);
  assert.deepEqual(
    order,
    ['version', 'applying', 'save', 'settle-applied', 'apply', 'clear', 'durable-clear'],
  );
  assert.deepEqual(errors, []);

  const failedOrder: string[] = [];
  const failedErrors: string[] = [];
  const failedState = proposalState(proposal, failedOrder, failedErrors);
  await applySelectedProposal(
    failedState,
    'proposal-persistence-verify',
    new Set([0]),
    proposalPersistence(failedOrder, { saveDoc: async () => saveResult(false) }),
  );
  assert.equal(failedOrder.includes('apply'), false);
  assert.match(failedErrors[0] ?? '', /提案未应用/);
}
async function verifyConcurrentRestoreFailureFence(): Promise<void> {
  const proposal = buildProposal(
    [buildOperation(
      'rename_timeline',
      { timelineId: timeline.id, name: 'Concurrent' },
      [{ type: 'tl.rename', id: timeline.id, name: 'Concurrent' }],
    )],
    'Concurrent proposal', doc, { fps: 30, items: [] } as never,
  );
  const order: string[] = [];
  const errors: string[] = [];
  const state = proposalState(proposal, order, errors);
  const newerDoc: ProjectDoc = {
    ...doc,
    timelines: [{ ...timeline, width: 1440, height: 1440 }],
  };
  let saves = 0;
  await applySelectedProposal(
    state,
    'proposal-concurrent-restore-verify',
    new Set([0]),
    proposalPersistence(order, {
      saveDoc: async () => {
        saves += 1;
        order.push(`save-${saves}`);
        if (saves === 1) state.ctxRef.current.commands.applyDoc(newerDoc);
        return saveResult(saves === 1);
      },
    }),
  );
  assert.equal(saves, 2, 'the newer live document is offered to durable persistence');
  assert.equal(state.ctxRef.current.getDoc(), newerDoc, 'failed recovery never overwrites the newer live document');
  assert.equal(order.filter((entry) => entry === 'apply').length, 1);
  assert.equal(order.some((entry) => entry.startsWith('settle-')), false);
  assert.equal(order.includes('durable-clear'), false, 'the applying recovery record remains durable');
  assert.match(errors[0] ?? '', /提案未应用/);
}

async function verifyCommittedRecoveryFence(): Promise<void> {
  const proposal = buildProposal(
    [buildOperation(
      'rename_timeline',
      { timelineId: timeline.id, name: 'Recovered' },
      [{ type: 'tl.rename', id: timeline.id, name: 'Recovered' }],
    )],
    'Recovered proposal', doc, { fps: 30, items: [] } as never,
  );
  const quotaOrder: string[] = [];
  const quotaErrors: string[] = [];
  await applySelectedProposal(
    proposalState(proposal, quotaOrder, quotaErrors),
    'proposal-persistence-verify',
    new Set([0]),
    proposalPersistence(quotaOrder, {
      markApplying: async () => { quotaOrder.push('applying'); throw new Error('quota'); },
    }),
  );
  assert.equal(quotaOrder.includes('save'), false);
  assert.equal(quotaOrder.includes('apply'), false);
  assert.match(quotaErrors[0] ?? '', /提案未应用/);

  const crashOrder: string[] = [];
  const crashErrors: string[] = [];
  await applySelectedProposal(
    proposalState(proposal, crashOrder, crashErrors),
    'proposal-persistence-verify',
    new Set([0]),
    proposalPersistence(crashOrder, {
      settle: async () => { crashOrder.push('settle-applied'); throw new Error('crash'); },
    }),
  );
  assert.equal(crashOrder.includes('apply'), true, 'a saved document remains applied if settlement cleanup fails');
  assert.equal(crashOrder.includes('durable-clear'), false, 'the applying recovery record remains durable');
  assert.match(crashErrors[0] ?? '', /已保存到工程/);
}

async function verifyProposalOwnershipFence(): Promise<void> {
  const proposal = buildProposal(
    [buildOperation(
      'rename_timeline',
      { timelineId: timeline.id, name: 'Owned' },
      [{ type: 'tl.rename', id: timeline.id, name: 'Owned' }],
    )],
    'Ownership', doc, { fps: 30, items: [] } as never,
  );
  const unowned = { ...proposal, agentRunId: 'missing-run' };
  const applyOrder: string[] = [];
  const applyErrors: string[] = [];
  await applySelectedProposal(
    proposalState(unowned, applyOrder, applyErrors), 'proposal-persistence-verify', new Set([0]),
  );
  assert.equal(applyOrder.includes('apply'), false);
  assert.match(applyErrors[0] ?? '', /运行权限/);
  const rejectOrder: string[] = [];
  const rejectErrors: string[] = [];
  await rejectPendingProposal(
    proposalState(unowned, rejectOrder, rejectErrors),
    'proposal-persistence-verify',
    proposalPersistence(rejectOrder, {
      // The rejection itself succeeds; only the follow-up cleanup fails.
      // The user-facing warning must still say the proposal was rejected.
      clear: async () => {
        rejectOrder.push('durable-clear');
        throw new Error('cleanup failure');
      },
    }),
  );
  assert.equal(rejectOrder.includes('clear'), true);
  assert.match(rejectErrors[0] ?? '', /已拒绝/);
}

function persistentTurn(order: string[], controller = new AbortController()): AgentTurn {
  let currentDoc = doc;
  const turn = {
    state: {
      llmProviderRef: { current: '' },
      ctxRef: {
        current: {
          getDoc: () => currentDoc,
          commands: {
            applyDoc: (next: ProjectDoc) => {
              order.push('apply');
              currentDoc = next;
            },
          },
        },
      },
      setMessages: () => undefined,
      setChangeLog: () => undefined,
    },
    projectId: 'proposal-persistence-verify',
    persistentSnapshot: Promise.resolve(),
    persistentSaveError: undefined,
    persistentBeforeDoc: doc,
    persistentOps: [buildOperation(
      'rename_timeline',
      { timelineId: timeline.id, name: 'Persistent' },
      [{ type: 'tl.rename', id: timeline.id, name: 'Persistent' }],
    )],
    draftInvalidated: false,
    abortController: controller,
    assistantText: 'rename',
    completionStatus: 'completed',
  };
  return turn as unknown as AgentTurn;
}

async function verifyPersistentAutoApplyFence(): Promise<void> {
  const successOrder: string[] = [];
  const success = await commitPersistentOperations(persistentTurn(successOrder), async () => {
    successOrder.push('save');
    return saveResult(true);
  });
  assert.equal(success, true);
  assert.deepEqual(successOrder, ['save', 'apply']);

  const failedOrder: string[] = [];
  const failed = await commitPersistentOperations(persistentTurn(failedOrder), async () => {
    failedOrder.push('save');
    return saveResult(false);
  });
  assert.equal(failed, false);
  assert.deepEqual(failedOrder, ['save']);

  const stoppedOrder: string[] = [];
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let saves = 0;
  const stopped = commitPersistentOperations(persistentTurn(stoppedOrder, controller), async () => {
    saves += 1;
    stoppedOrder.push(`save-${saves}`);
    if (saves === 1) {
      entered.resolve();
      await release.promise;
    }
    return saveResult(true);
  });
  await entered.promise;
  controller.abort();
  release.resolve();
  assert.equal(await stopped, false);
  assert.equal(stoppedOrder.includes('apply'), false);
  assert.equal(saves, 2, 'an abort during persistence restores the pre-change project document');
}

async function verifyPendingProposalDurabilityFence(): Promise<void> {
  let exposed = false;
  let recorded = false;
  const turn = {
    state: {
      setProposalStale: () => undefined,
      setProposal: () => { exposed = true; },
    },
    projectId: 'proposal-persistence-verify',
    runId: 'run-pending-write',
    ops: [buildOperation(
      'rename_timeline',
      { timelineId: timeline.id, name: 'Pending' },
      [{ type: 'tl.rename', id: timeline.id, name: 'Pending' }],
    )],
    assistantText: 'Pending',
    proposalBaseDoc: doc,
    draft: makeDraft(doc),
    recorder: {
      runId: 'run-pending-write',
      recordProposal: async () => { recorded = true; },
    },
    abortController: new AbortController(),
    completionStatus: 'completed',
    draftInvalidated: false,
  } as unknown as AgentTurn;
  await assert.rejects(
    () => createPendingProposal(turn, async () => { throw new Error('quota'); }),
    /quota/,
  );
  assert.equal(turn.completionStatus, 'completed');
  assert.equal(recorded, false);
  assert.equal(exposed, false);
}

const linked = parseProposal(buildProposal(
  [denoise('/voice-linked.m4a')],
  'Linked proposal',
  doc,
  { fps: 30, items: [] } as never,
  'run-proposal-1',
));
assert.equal(linked?.agentRunId, 'run-proposal-1', 'durable run linkage must survive proposal parsing');
assert.ok(linked?.id, 'built-in proposals have a stable durable event identity');
assert.notEqual(linked?.id, linked?.agentRunId, 'proposal identity remains distinct from the owning run');
const { agentRunId: _omitted, id: _legacyId, ...legacyRaw } = linked!;
assert.equal(parseProposal(legacyRaw)?.agentRunId, undefined, 'legacy proposals without linkage or id remain valid');
assert.equal(parseProposal({ ...linked, agentRunId: 42 }), null, 'malformed run linkage is rejected');
assert.equal(parseProposal({ ...linked, id: 42 }), null, 'malformed proposal identity is rejected');
const applyingRecord = parseStoredProposalRecord({
  version: 1,
  phase: 'applying',
  proposal: linked,
  application: { resultDoc: doc, operationCount: 1, startedAt: 1 },
});
assert.equal(applyingRecord?.phase, 'applying');
assert.equal(applyingRecord?.application?.operationCount, 1);
const settledRecord = parseStoredProposalRecord({
  ...applyingRecord,
  phase: 'settled',
  settlement: { outcome: 'applied', settledAt: 2 },
});
assert.equal(settledRecord?.phase, 'settled');
assert.equal(settledRecord?.settlement.outcome, 'applied');
assert.throws(
  () => parseStoredProposalRecord({ version: 2, phase: 'prepared', proposal: linked }),
  /Unsupported proposal store version/,
  'future proposal records are preserved and rejected rather than downgraded',
);
assert.equal(statusAfterMaxToolTurns('awaiting_user'), 'completed');
assert.equal(statusAfterMaxToolTurns('completed'), 'completed');
assert.equal(projectReduce(doc, { type: 'tl.switch', id: timeline.id }), doc);

// Pool imports land per tool call, on whatever the project is at that moment.
async function verifyPersistentLandingFence(): Promise<void> {
  const asset = (id: string) => ({ id, name: `${id}.mp4`, kind: 'video', src: `/media/uploads/${id}.mp4` }) as unknown as ProjectDoc['assets'][number];
  const importOp = (id: string) => buildOperation('download_media', { url: id }, [{ type: 'addAsset', asset: asset(id) }]);
  function landingTurn(startDoc: ProjectDoc, ops: ReturnType<typeof importOp>[], order: string[]) {
    let currentDoc = startDoc;
    let changeLog: AgentChangeSession[] = [];
    const turn = {
      state: {
        llmProviderRef: { current: '' },
        ctxRef: {
          current: {
            getDoc: () => currentDoc,
            commands: { applyDoc: (next: ProjectDoc) => { order.push('apply'); currentDoc = next; } },
          },
        },
        setMessages: () => undefined,
        setChangeLog: (update: (current: AgentChangeSession[]) => AgentChangeSession[]) => { changeLog = update(changeLog); },
      },
      projectId: 'proposal-persistence-verify',
      persistentSnapshot: Promise.resolve(),
      persistentSaveError: undefined,
      persistentBeforeDoc: startDoc,
      persistentSessionId: null,
      persistentOps: ops,
      draftInvalidated: false,
      abortController: new AbortController(),
      assistantText: '',
      completionStatus: 'completed',
    };
    return {
      turn: turn as unknown as AgentTurn,
      doc: () => currentDoc,
      edit: (next: ProjectDoc) => { currentDoc = next; },
      changeLog: () => changeLog,
    };
  }

  // An import already in the pool (a resumed run replaying its landings) touches nothing.
  {
    const order: string[] = [];
    const present = landingTurn({ ...doc, assets: [asset('a')] }, [importOp('a')], order);
    assert.equal(await commitPersistentOperations(present.turn, async () => { order.push('save'); return saveResult(true); }), true);
    assert.deepEqual(order, [], 'nothing to save or apply');
    assert.equal(present.turn.persistentOps.length, 0, 'the landed ops are cleared');
  }

  // The user renames the timeline while the import is being saved: the saved copy lacks that
  // edit, so the live document is put back and the import replayed on top of it. Both survive.
  {
    const order: string[] = [];
    const moving = landingTurn(doc, [importOp('a')], order);
    let saves = 0;
    const committed = await commitPersistentOperations(moving.turn, async (_projectId, saved) => {
      saves += 1;
      order.push(`save-${saves}:${saved.timelines[0]?.name}/${saved.assets.map((item) => item.id).join(',') || '-'}`);
      if (saves === 1) moving.edit({ ...moving.doc(), timelines: [{ ...timeline, name: 'Renamed' }] });
      return saveResult(true);
    });
    assert.equal(committed, true);
    assert.deepEqual(order, [
      'save-1:Timeline/a',
      'save-2:Renamed/-',
      'save-3:Renamed/a',
      'apply',
    ], 'the user edit is restored, then the import is replayed on top');
    assert.equal(moving.doc().timelines[0]?.name, 'Renamed');
    assert.deepEqual(moving.doc().assets.map((item) => item.id), ['a']);
  }

  // Two landings in one run share one change-log row; the second extends the first.
  {
    const order: string[] = [];
    const twice = landingTurn(doc, [importOp('a')], order);
    const persist = async () => { order.push('save'); return saveResult(true); };
    assert.equal(await commitPersistentOperations(twice.turn, persist), true);
    assert.equal(twice.changeLog().length, 1);
    const firstId = twice.changeLog()[0]?.id;
    assert.ok(firstId);
    assert.equal(twice.turn.persistentSessionId, firstId);
    twice.turn.persistentOps = [importOp('b')];
    assert.equal(await commitPersistentOperations(twice.turn, persist), true);
    assert.equal(twice.changeLog().length, 1, 'still one row');
    assert.equal(twice.changeLog()[0]?.id, firstId);
    assert.deepEqual(twice.changeLog()[0]?.operations.map((operation) => operation.target), [importOp('a').target, importOp('b').target]);
    assert.deepEqual(twice.doc().assets.map((item) => item.id), ['a', 'b']);
    assert.equal(canRollbackAgentChange(twice.changeLog()[0]!, twice.doc()), true, 'the row rolls back from the latest landing');
    assert.equal(rollbackAgentChange(twice.changeLog()[0]!, twice.doc())?.assets.length, 0, 'rolling back removes every landing of the run');
  }
}

await verifyProposalPersistenceFence();
await verifyConcurrentRestoreFailureFence();
await verifyCommittedRecoveryFence();
await verifyProposalOwnershipFence();
await verifyPersistentAutoApplyFence();
await verifyPersistentLandingFence();
await verifyPendingProposalDurabilityFence();
console.log('proposal compaction checks passed');
