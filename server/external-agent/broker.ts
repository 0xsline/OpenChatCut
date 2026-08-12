import { randomUUID } from 'node:crypto';
import type { ProjectEditOwnershipClaim } from './project-edit-ownership.ts';
import {
  EditorConnectionRegistry,
  sameEditorBinding as sameBinding,
  sameEditorIdentity,
} from './broker-registry.ts';
import {
  ExternalEditorCallError,
  type EditorBinding,
  type ExternalCallTerminalOutcome,
  type ExternalToolSchema,
} from './broker-types.ts';

export { ExternalEditorCallError } from './broker-types.ts';
export type {
  EditorBinding,
  ExternalCallTerminalOutcome,
  ExternalToolSchema,
} from './broker-types.ts';

interface EditSessionOwner {
  ownerId: string;
  binding: EditorBinding;
}
interface QueuedCall {
  id: string;
  ownerId: string;
  binding: EditorBinding;
  name: string;
  arguments: Record<string, unknown>;
  state: 'queued' | 'in_flight';
  allowRevisionDrift: boolean;
  deadline: number;
  resolve: (value: unknown) => void;
  reject: (error: ExternalEditorCallError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ExternalEditorCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  binding: EditorBinding;
}

export interface ExternalEditorCancellation {
  id: string;
  outcome: Exclude<ExternalCallTerminalOutcome, 'applied'>;
  message: string;
  /** Edit sessions orphaned by the owner transport disconnect; the editor discards them. */
  ownerGone?: string[];
}

const DEFAULT_TIMEOUT_MS = 180_000;
const MAX_TIMEOUT_MS = 600_000;
const queues = new Map<string, QueuedCall[]>();
const pending = new Map<string, QueuedCall>();
const waiters = new Map<string, Set<() => void>>();
const editSessionOwners = new Map<string, EditSessionOwner>();
const cancellationQueues = new Map<string, ExternalEditorCancellation[]>();
const cancellationWaiters = new Map<string, Set<() => void>>();

const editorKey = (projectId: string, editorInstanceId: string) => `${projectId}\u0000${editorInstanceId}`;


function wake(waiterMap: Map<string, Set<() => void>>, key: string): void {
  for (const waiter of waiterMap.get(key) ?? []) waiter();
}

function waitForWake(
  waiterMap: Map<string, Set<() => void>>,
  key: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      const listeners = waiterMap.get(key);
      listeners?.delete(finish);
      if (!listeners?.size) waiterMap.delete(key);
      resolve();
    };
    const listeners = waiterMap.get(key) ?? new Set<() => void>();
    listeners.add(finish);
    waiterMap.set(key, listeners);
    const timer = setTimeout(finish, timeoutMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}


function removeQueuedCall(call: QueuedCall): void {
  if (call.state !== 'queued') return;
  const queue = queues.get(call.binding.projectId);
  const index = queue?.findIndex((candidate) => candidate.id === call.id) ?? -1;
  if (queue && index >= 0) queue.splice(index, 1);
  if (!queue?.length) queues.delete(call.binding.projectId);
}

function enqueueCancellation(
  call: QueuedCall,
  outcome: Exclude<ExternalCallTerminalOutcome, 'applied'>,
  message: string,
): void {
  const key = editorKey(call.binding.projectId, call.binding.editorInstanceId);
  const queue = cancellationQueues.get(key) ?? [];
  queue.push({ id: call.id, outcome, message });
  cancellationQueues.set(key, queue);
  wake(cancellationWaiters, key);
}

function terminalMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const encoded = JSON.stringify(value);
    if (encoded !== undefined) return encoded;
  } catch {
    // Fall through to a representation that cannot strand the promise.
  }
  return String(value);
}

function recordEditSessionOwner(call: QueuedCall, value: unknown): void {
  if (
    call.name !== 'begin_edit_session'
    || !value
    || typeof value !== 'object'
    || Array.isArray(value)
  ) return;
  if (!('editSessionId' in value)) return;
  const editSessionId = value.editSessionId;
  if (typeof editSessionId !== 'string' || !editSessionId.trim()) return;
  editSessionOwners.set(editSessionId.trim(), {
    ownerId: call.ownerId,
    binding: { ...call.binding },
  });
}

function finishCall(
  call: QueuedCall,
  outcome: ExternalCallTerminalOutcome,
  value: unknown,
  notifyEditor: boolean,
): boolean {
  if (!pending.delete(call.id)) return false;
  clearTimeout(call.timer);
  removeQueuedCall(call);
  wake(waiters, call.binding.projectId);
  if (outcome === 'applied') {
    recordEditSessionOwner(call, value);
    call.resolve(value);
    return true;
  }
  const message = terminalMessage(value);
  if (notifyEditor && call.state === 'in_flight') enqueueCancellation(call, outcome, message);
  call.reject(new ExternalEditorCallError(outcome, message));
  return true;
}

function cancelCalls(
  predicate: (call: QueuedCall) => boolean,
  outcome: Exclude<ExternalCallTerminalOutcome, 'applied'>,
  message: string,
  notifyEditor = true,
): number {
  let count = 0;
  for (const call of [...pending.values()]) {
    if (predicate(call) && finishCall(call, outcome, message, notifyEditor)) count += 1;
  }
  return count;
}

const registry = new EditorConnectionRegistry({
  bindingReplaced(binding, sameEditor) {
    cancelCalls(
      (call) => sameEditor
        ? sameBinding(call.binding, binding) && !call.allowRevisionDrift
        : sameEditorIdentity(call.binding, binding),
      sameEditor ? 'stale' : 'cancelled',
      sameEditor
        ? `Project ${binding.projectId} changed while the editor call was pending.`
        : `Editor ${binding.editorInstanceId} closed or switched projects.`,
    );
  },
  revisionChanged(binding) {
    cancelCalls(
      (call) => sameBinding(call.binding, binding) && !call.allowRevisionDrift,
      'stale',
      `Project ${binding.projectId} changed while the editor call was pending.`,
    );
  },
  editorRemoved(binding) {
    cancelCalls(
      (call) => sameEditorIdentity(call.binding, binding),
      'cancelled',
      `Editor ${binding.editorInstanceId} closed or switched projects.`,
    );
  },
  wakeProject(projectId) {
    wake(waiters, projectId);
  },
  hasInFlightCall(projectId) {
    return [...pending.values()].some((call) => (
      call.binding.projectId === projectId && call.state === 'in_flight'
    ));
  },
});

export function registerEditor(
  projectId: string, editorInstanceId: string,
  baseRevision: string, tools: ExternalToolSchema[],
  ownership?: ProjectEditOwnershipClaim,
  registrationCapability?: string | null,
): string {
  return registry.register(
    projectId,
    editorInstanceId,
    baseRevision,
    tools,
    ownership,
    registrationCapability,
  );
}

export function editorRegistrationMatches(
  projectId: string, editorInstanceId: string,
  registrationCapability: string | null | undefined,
): boolean {
  return registry.registrationMatches(projectId, editorInstanceId, registrationCapability);
}

export function unregisterEditor(
  projectId: string, editorInstanceId: string,
  registrationCapability?: string | null,
): Promise<boolean> {
  return registry.unregister(projectId, editorInstanceId, registrationCapability);
}

export function onRegisteredToolsChanged(listener: () => void): () => void {
  return registry.onToolsChanged(listener);
}

export function touchEditor(
  projectId: string, editorInstanceId: string,
  baseRevision?: string, registrationCapability?: string | null,
): Promise<boolean> {
  return registry.touch(projectId, editorInstanceId, baseRevision, registrationCapability);
}

export function editorBinding(projectId: string): EditorBinding | null {
  return registry.binding(projectId);
}

export function editorBindingMatches(binding: EditorBinding): boolean {
  return registry.bindingMatches(binding);
}

export function editorBindingIdentityMatches(binding: EditorBinding): boolean {
  return registry.identityMatches(binding);
}

export function connectedProjectIds(): string[] {
  return registry.connectedProjectIds();
}

export function isProjectConnected(projectId: string, now = Date.now()): boolean {
  return registry.isConnected(projectId, now);
}

export function editorStatuses(): Array<{
  projectId: string;
  editorId: string;
  baseRevision: string;
  connected: boolean;
  toolCount: number;
}> {
  return registry.statuses();
}

export function registeredTools(): ExternalToolSchema[] {
  return registry.tools();
}

export function editSessionOwnerMatches(
  ownerId: string,
  binding: EditorBinding,
  editSessionId: unknown,
): boolean {
  if (typeof editSessionId !== 'string') return false;
  const owner = editSessionOwners.get(editSessionId.trim());
  return Boolean(
    owner
    && owner.ownerId === ownerId
    && sameBinding(owner.binding, binding)
  );
}

function requireOwnedEditSession(
  ownerId: string,
  binding: EditorBinding,
  args: Record<string, unknown>,
): void {
  if (editSessionOwnerMatches(ownerId, binding, args.editSessionId)) return;
  throw new ExternalEditorCallError(
    'rejected',
    'The requested edit session does not belong to this MCP transport and editor binding.',
  );
}

function requireCurrentBinding(
  binding: EditorBinding,
  allowRevisionDrift: boolean,
  allowAdopt: boolean,
): EditorBinding {
  // Terminal status reads may use the original editor identity after apply
  // advances the revision; every mutation remains pinned to the exact binding.
  const matches = allowRevisionDrift
    ? editorBindingIdentityMatches(binding)
    : editorBindingMatches(binding);
  if (matches) return binding;
  // A same-editor revision advance between bind and invoke (an autosave landing
  // or a settle syncing the registry) is legitimate progression, not a stale
  // takeover: adopt the registry's current snapshot for calls that carry no
  // edit-session ownership (begin_edit_session / sessionless reads). Calls
  // pinned to an edit session stay strict — the session snapshot is the guard.
  const current = editorBinding(binding.projectId);
  if (allowAdopt
    && current
    && sameEditorIdentity(current, binding)
    && editorBindingMatches(current)) {
    return current;
  }
  throw new ExternalEditorCallError(
    'stale',
    `MCP session binding for project ${binding.projectId} is stale. Re-initialize the MCP session.`,
  );
}

export function invokeEditorTool(
  ownerId: string,
  binding: EditorBinding,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<unknown> {
  const allowRevisionDrift = name === 'get_edit_session';
  const ownsSession = name !== 'begin_edit_session' && 'editSessionId' in args;
  if (ownsSession) {
    requireOwnedEditSession(ownerId, binding, args);
  }
  const currentBinding = requireCurrentBinding(binding, allowRevisionDrift, !ownsSession);
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + Math.min(MAX_TIMEOUT_MS, Math.max(1_000, timeoutMs));
    const call: QueuedCall = {
      id: randomUUID(),
      ownerId,
      binding: { ...currentBinding },
      name,
      arguments: args,
      state: 'queued',
      allowRevisionDrift,
      deadline,
      resolve,
      reject,
      timer: setTimeout(() => {
        finishCall(
          call,
          'cancelled',
          `OpenChatCut tool ${name} timed out before a terminal result was received.`,
          true,
        );
      }, deadline - Date.now()),
    };
    const queue = queues.get(binding.projectId) ?? [];
    queue.push(call);
    queues.set(binding.projectId, queue);
    pending.set(call.id, call);
    wake(waiters, binding.projectId);
  });
}

function takeNextCall(projectId: string, binding: EditorBinding): QueuedCall | undefined {
  const queue = queues.get(projectId);
  while (queue?.length) {
    const call = queue.shift()!;
    if (!pending.has(call.id)) continue;
    if (call.deadline <= Date.now()) {
      finishCall(call, 'cancelled', `OpenChatCut tool ${call.name} timed out before dispatch.`, false);
      continue;
    }
    if (
      !sameBinding(call.binding, binding)
      && !(call.allowRevisionDrift && sameEditorIdentity(call.binding, binding))
    ) {
      finishCall(
        call,
        'stale',
        `MCP session binding for project ${projectId} is stale. Re-initialize the MCP session.`,
        false,
      );
      continue;
    }
    call.state = 'in_flight';
    if (!queue.length) queues.delete(projectId);
    return call;
  }
  if (!queue?.length) queues.delete(projectId);
  return undefined;
}

export async function nextEditorCall(
  projectId: string,
  editorInstanceId: string,
  baseRevision: string,
  signal: AbortSignal,
  registrationCapability?: string | null,
): Promise<ExternalEditorCall | null> {
  if (!(await touchEditor(
    projectId,
    editorInstanceId,
    baseRevision,
    registrationCapability,
  ))) return null;
  let binding = editorBinding(projectId);
  let call = binding ? takeNextCall(projectId, binding) : undefined;
  if (!call) {
    await waitForWake(waiters, projectId, signal, 25_000);
    if (signal.aborted || !(await touchEditor(
      projectId,
      editorInstanceId,
      baseRevision,
      registrationCapability,
    ))) return null;
    binding = editorBinding(projectId);
    call = binding ? takeNextCall(projectId, binding) : undefined;
  }
  if (!call) return null;
  return {
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    binding: call.binding,
  };
}

export async function nextEditorCancellation(
  projectId: string,
  editorInstanceId: string,
  signal: AbortSignal,
  registrationCapability?: string | null,
): Promise<ExternalEditorCancellation | null> {
  if (registrationCapability !== undefined
    && !editorRegistrationMatches(projectId, editorInstanceId, registrationCapability)) return null;
  const key = editorKey(projectId, editorInstanceId);
  let cancellation = cancellationQueues.get(key)?.shift();
  if (!cancellation) {
    await waitForWake(cancellationWaiters, key, signal, 25_000);
    if (registrationCapability !== undefined
      && !editorRegistrationMatches(projectId, editorInstanceId, registrationCapability)) return null;
    cancellation = cancellationQueues.get(key)?.shift();
  }
  if (!cancellationQueues.get(key)?.length) cancellationQueues.delete(key);
  return cancellation ?? null;
}

/** Binding of a pending editor call, read before settle for revision sync. */
export function editorCallBinding(id: string): EditorBinding | null {
  const call = pending.get(id);
  return call ? { ...call.binding } : null;
}

export function settleEditorCall(
  id: string,
  outcome: ExternalCallTerminalOutcome,
  value: unknown,
  registrationCapability?: string | null,
): boolean {
  const call = pending.get(id);
  if (!call) return false;
  if (registrationCapability !== undefined
    && !editorRegistrationMatches(
      call.binding.projectId,
      call.binding.editorInstanceId,
      registrationCapability,
    )) return false;
  return finishCall(call, outcome, value, false);
}

export function cancelEditorCallsForOwner(
  ownerId: string,
  outcome: Extract<ExternalCallTerminalOutcome, 'cancelled' | 'stale' | 'failed'> = 'cancelled',
  message = 'MCP transport session closed before the editor call completed.',
): number {
  const orphanedByEditor = new Map<string, string[]>();
  for (const [sessionId, owner] of editSessionOwners) {
    if (owner.ownerId !== ownerId) continue;
    editSessionOwners.delete(sessionId);
    const key = editorKey(owner.binding.projectId, owner.binding.editorInstanceId);
    const list = orphanedByEditor.get(key) ?? [];
    list.push(sessionId);
    orphanedByEditor.set(key, list);
  }
  // Let each connected editor discard the sessions its transport orphaned, so a
  // crashed or closed MCP client cannot leave a drafting session wedged forever.
  for (const [key, sessionIds] of orphanedByEditor) {
    const queue = cancellationQueues.get(key) ?? [];
    queue.push({
      id: '',
      outcome,
      message: `MCP transport session closed; ${sessionIds.length} edit session(s) orphaned.`,
      ownerGone: sessionIds,
    });
    cancellationQueues.set(key, queue);
    wake(cancellationWaiters, key);
  }
  return cancelCalls((call) => call.ownerId === ownerId, outcome, message);
}

export function pendingEditorCallsForTest(ownerId?: string): Array<{
  id: string;
  ownerId: string;
  state: 'queued' | 'in_flight';
}> {
  return [...pending.values()]
    .filter((call) => ownerId === undefined || call.ownerId === ownerId)
    .map((call) => ({ id: call.id, ownerId: call.ownerId, state: call.state }));
}

export function resetExternalAgentBrokerForTest(): void {
  cancelCalls(() => true, 'cancelled', 'External agent broker reset.', false);
  registry.reset();
  queues.clear();
  waiters.clear();
  cancellationQueues.clear();
  cancellationWaiters.clear();
  editSessionOwners.clear();
}
