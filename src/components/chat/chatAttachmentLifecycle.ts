import type { AgentReference } from '../../agent/context';
import { refPromptToken } from '../../agent/selection-refs';

export interface ChatAttachmentImportToken {
  readonly generation: number;
  readonly nonce: number;
}

export type ChatAttachmentImportStatus = 'pending' | 'ready' | 'cancelled';

export interface ChatAttachmentImportRecord {
  readonly token: ChatAttachmentImportToken;
  readonly placeholderId: string | null;
  readonly status: ChatAttachmentImportStatus;
}

export interface ChatAttachmentLifecycleState {
  readonly generation: number;
  readonly nextNonce: number;
  readonly imports: readonly ChatAttachmentImportRecord[];
}

export interface ChatAttachmentTransition {
  readonly state: ChatAttachmentLifecycleState;
  readonly references: AgentReference[];
  readonly accepted: boolean;
  readonly previousReference?: AgentReference;
}

export function createChatAttachmentLifecycleState(): ChatAttachmentLifecycleState {
  return { generation: 0, nextNonce: 1, imports: [] };
}

export function beginChatAttachmentImport(
  state: ChatAttachmentLifecycleState,
): { state: ChatAttachmentLifecycleState; token: ChatAttachmentImportToken } {
  const token = { generation: state.generation, nonce: state.nextNonce };
  return {
    token,
    state: {
      ...state,
      nextNonce: state.nextNonce + 1,
      imports: [...state.imports, { token, placeholderId: null, status: 'pending' }],
    },
  };
}

function activeImportIndex(
  state: ChatAttachmentLifecycleState,
  token: ChatAttachmentImportToken,
): number {
  if (token.generation !== state.generation) return -1;
  return state.imports.findIndex((entry) =>
    entry.status === 'pending'
    && entry.token.generation === token.generation
    && entry.token.nonce === token.nonce);
}

function replaceImport(
  state: ChatAttachmentLifecycleState,
  index: number,
  next: ChatAttachmentImportRecord,
): ChatAttachmentLifecycleState {
  return {
    ...state,
    imports: state.imports.map((entry, itemIndex) => itemIndex === index ? next : entry),
  };
}

export function attachChatAttachmentPlaceholder(
  state: ChatAttachmentLifecycleState,
  references: readonly AgentReference[],
  token: ChatAttachmentImportToken,
  placeholder: AgentReference,
): ChatAttachmentTransition {
  const index = activeImportIndex(state, token);
  const entry = index < 0 ? null : state.imports[index];
  if (!entry || entry.placeholderId !== null) {
    return { state, references: [...references], accepted: false };
  }
  return {
    state: replaceImport(state, index, { ...entry, placeholderId: placeholder.id }),
    references: upsertChatAttachmentReference(references, placeholder),
    accepted: true,
  };
}

export function resolveChatAttachmentImport(
  state: ChatAttachmentLifecycleState,
  references: readonly AgentReference[],
  token: ChatAttachmentImportToken,
  ready: AgentReference,
): ChatAttachmentTransition {
  const index = activeImportIndex(state, token);
  const entry = index < 0 ? null : state.imports[index];
  if (!entry) return { state, references: [...references], accepted: false };
  if (entry.placeholderId !== ready.id) {
    return {
      state: replaceImport(state, index, { ...entry, status: 'cancelled' }),
      references: [...references],
      accepted: false,
    };
  }
  const referenceIndex = references.findIndex((reference) => reference.id === entry.placeholderId);
  if (referenceIndex < 0) {
    return {
      state: replaceImport(state, index, { ...entry, status: 'cancelled' }),
      references: [...references],
      accepted: false,
    };
  }
  return {
    state: replaceImport(state, index, { ...entry, status: 'ready' }),
    references: references.map((reference, itemIndex) => itemIndex === referenceIndex ? ready : reference),
    accepted: true,
    previousReference: references[referenceIndex],
  };
}

export function failChatAttachmentImport(
  state: ChatAttachmentLifecycleState,
  references: readonly AgentReference[],
  token: ChatAttachmentImportToken,
): ChatAttachmentTransition {
  const index = activeImportIndex(state, token);
  const entry = index < 0 ? null : state.imports[index];
  if (!entry) return { state, references: [...references], accepted: false };
  const previousReference = entry.placeholderId
    ? references.find((reference) => reference.id === entry.placeholderId)
    : undefined;
  return {
    state: replaceImport(state, index, { ...entry, status: 'cancelled' }),
    references: entry.placeholderId
      ? removeChatAttachmentReference(references, entry.placeholderId)
      : [...references],
    accepted: true,
    previousReference,
  };
}

export function cancelChatAttachmentImportByReference(
  state: ChatAttachmentLifecycleState,
  id: string,
): ChatAttachmentLifecycleState {
  let changed = false;
  const imports = state.imports.map((entry) => {
    if (entry.placeholderId !== id || entry.status === 'cancelled') return entry;
    changed = true;
    return { ...entry, status: 'cancelled' as const };
  });
  return changed ? { ...state, imports } : state;
}

export function resetChatAttachmentLifecycle(
  state: ChatAttachmentLifecycleState,
): ChatAttachmentLifecycleState {
  return { generation: state.generation + 1, nextNonce: state.nextNonce, imports: [] };
}

export function pendingChatAttachmentCount(state: ChatAttachmentLifecycleState): number {
  return state.imports.reduce((count, entry) =>
    count + (entry.status === 'pending' && entry.token.generation === state.generation ? 1 : 0), 0);
}

export function replaceChatAttachmentPromptToken(
  input: string,
  previous: AgentReference,
  next: AgentReference,
): string {
  const previousToken = refPromptToken(previous);
  const nextToken = refPromptToken(next);
  if (previousToken === nextToken) return input;
  const escaped = previousToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return input.replace(new RegExp(`${escaped}(?=\\s|$)`, 'g'), nextToken);
}

/**
 * Chip-only references are independent from textarea text. References with an
 * inline token are removed only when that token existed before this edit and
 * the user deleted it.
 */
export function referencesAfterComposerTextEdit<T extends AgentReference>(
  current: T[],
  previousValue: string,
  nextValue: string,
): T[] {
  const removed = current.some((reference) => {
    const token = refPromptToken(reference);
    return previousValue.includes(token) && !nextValue.includes(token);
  });
  if (!removed) return current;
  return current.filter((reference) => {
    const token = refPromptToken(reference);
    return nextValue.includes(token) || !previousValue.includes(token);
  });
}

export function upsertChatAttachmentReference(
  current: readonly AgentReference[],
  next: AgentReference,
): AgentReference[] {
  const index = current.findIndex((reference) => reference.id === next.id);
  if (index < 0) return [...current, next];
  return current.map((reference, itemIndex) => itemIndex === index ? next : reference);
}

export function removeChatAttachmentReference(
  current: readonly AgentReference[],
  id: string,
): AgentReference[] {
  return current.filter((reference) => reference.id !== id);
}
