import assert from 'node:assert/strict';
import { setAgentAutoApply } from './approval-mode';
import { requestRuntimeGuard } from './useAgentRun';
import type { AgentHookState } from './useAgentState';
import type { RuntimeGuardRequest } from './runtime-guard';

const guard: RuntimeGuardRequest = {
  skill: 'high-cost-operation',
  tool: 'download_media',
  permissionKind: 'persistent_local',
  approval: 'once',
  summary: '将持久修改本机或工程数据：下载媒体到 /media/uploads/',
  details: [],
};

const pendingCalls: unknown[] = [];
const state = {
  pendingGuardRef: { current: null },
  setPendingGuard: (value: unknown) => { pendingCalls.push(value); },
} as unknown as AgentHookState;

// YOLO mode releases every confirmation card immediately.
setAgentAutoApply(true);
const yoloDecision = await requestRuntimeGuard(state, 'project-yolo', guard);
assert.equal(yoloDecision, 'allow-once', 'yolo mode must allow the tool without prompting');
assert.equal(pendingCalls.length, 0, 'yolo mode must not raise a confirmation card');

// Ask mode still raises the card and waits for the user.
setAgentAutoApply(false);
let askDecision: string | null = null;
const askPromise = requestRuntimeGuard(state, 'project-ask', guard).then((d) => { askDecision = d; });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(pendingCalls.length, 1, 'ask mode must raise a confirmation card');
assert.equal(askDecision, null, 'ask mode must wait for the user decision');
const pending = pendingCalls[0] as { resolve: (requested: string) => void };
pending.resolve('allow-once');
await askPromise;
assert.equal(askDecision, 'allow-once', 'the user decision must resolve the pending guard');

console.log('approval-mode.verify: yolo releases all guards, ask mode keeps cards');
