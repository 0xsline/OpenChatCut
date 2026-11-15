import {
  cancelEditorCallsForOwner,
  connectedProjectIds,
  editorBinding,
  editorBindingIdentityMatches,
  editorBindingMatches,
  ExternalEditorCallError,
  orphanStaleEditorSessions,
  type EditorBinding,
} from './broker.ts';
import { sameEditorIdentity } from './broker-registry.ts';
import { OfflineExternalEditRuntime, type OfflineEditorBinding } from './offline-runtime.ts';

const VALID_STORED_PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;

export interface McpBindingSession {
  id: string | null;
  binding: EditorBinding | null;
  offline: OfflineExternalEditRuntime | null;
  staleReason: string | null;
}

export type McpTargetBinding = EditorBinding | OfflineEditorBinding;

export function requestedProjectId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function boundProjectId(session: McpBindingSession): string | null {
  return session.binding?.projectId ?? session.offline?.binding().projectId ?? null;
}

export function bindingMode(session: McpBindingSession): 'browser' | 'offline' | null {
  if (session.binding) return 'browser';
  if (session.offline) return 'offline';
  return null;
}

function defaultBrowserProjectId(): string {
  const connected = connectedProjectIds();
  if (connected.length === 1) return connected[0];
  if (!connected.length) {
    throw new ExternalEditorCallError(
      'rejected',
      'No OpenChatCut editor is connected. Call target_project with an existing project id for offline editing, or open the editor.',
    );
  }
  throw new ExternalEditorCallError(
    'rejected',
    'Multiple OpenChatCut projects are open; call target_project with the intended project.',
  );
}

export function markMcpSessionStale(session: McpBindingSession, message: string): void {
  if (!session.staleReason) session.staleReason = message;
  if (session.id) cancelEditorCallsForOwner(session.id, 'stale', message);
}

/**
 * Re-bind to the editor that currently serves the session's project — exactly
 * what an explicit target_project would do. Used when the editor reloaded or
 * was replaced, so an agent is not stranded on a stale binding that only a
 * manual reconnect could clear.
 */
function rebindToCurrentEditor(session: McpBindingSession): EditorBinding | null {
  const projectId = session.binding?.projectId;
  if (!projectId) return null;
  const current = editorBinding(projectId);
  if (!current || !editorBindingMatches(current)) return null;
  if (session.id) orphanStaleEditorSessions(session.id, current);
  session.binding = current;
  session.staleReason = null;
  return current;
}

function editorReplacedMessage(projectId: string): string {
  return `The OpenChatCut editor for project ${projectId} reloaded or changed, so this MCP session was re-bound to it automatically. `
    + 'Edit sessions started before that are now orphaned: call list_edit_sessions, then recover_edit_session '
    + 'with action "resume" (or "discard"), and retry this call.';
}

export function validateBrowserBinding(
  session: McpBindingSession,
  allowRevisionDrift = false,
  adoptSameIdentity = true,
  requireSameRevisionForAdopt = false,
): EditorBinding | null {
  if (session.staleReason) {
    // A stale binding is no longer terminal: once an editor serves the project
    // again, ordinary calls re-bind themselves instead of failing forever.
    if (!adoptSameIdentity || !rebindToCurrentEditor(session)) {
      throw new ExternalEditorCallError('stale', session.staleReason);
    }
    if (requireSameRevisionForAdopt) {
      throw new ExternalEditorCallError('stale', editorReplacedMessage(session.binding!.projectId));
    }
    return session.binding;
  }
  if (!session.binding) return null;
  const matches = allowRevisionDrift
    ? editorBindingIdentityMatches(session.binding)
    : editorBindingMatches(session.binding);
  if (matches) return session.binding;
  // A same-editor revision advance between bind and an editor tool call (an
  // autosave landing, a tool settle syncing the registry) is a legitimate
  // progression, not a stale takeover: re-bind to the registry's current
  // snapshot. Explicit edit-session calls retain their revision guard.
  const current = editorBinding(session.binding.projectId);
  if (adoptSameIdentity
    && current
    && sameEditorIdentity(current, session.binding)
    && (!requireSameRevisionForAdopt || current.baseRevision === session.binding.baseRevision)
    && editorBindingMatches(current)) {
    if (session.id) orphanStaleEditorSessions(session.id, current);
    session.binding = current;
    return current;
  }
  const projectId = session.binding.projectId;
  if (adoptSameIdentity && rebindToCurrentEditor(session)) {
    if (requireSameRevisionForAdopt) {
      throw new ExternalEditorCallError('stale', editorReplacedMessage(projectId));
    }
    return session.binding;
  }
  const message = `MCP session binding for project ${projectId} is stale. Call target_project with the same project id to reconnect; old edit sessions still require explicit recovery.`;
  markMcpSessionStale(session, message);
  throw new ExternalEditorCallError('stale', message);
}

export async function validateOfflineBinding(session: McpBindingSession): Promise<void> {
  if (session.staleReason) throw new ExternalEditorCallError('stale', session.staleReason);
  if (!session.offline) return;
  try {
    await session.offline.validateAvailability();
  } catch (error) {
    if (error instanceof ExternalEditorCallError && error.outcome === 'stale') {
      markMcpSessionStale(session, error.message);
    }
    throw error;
  }
}

export function bindBrowserForCall(
  session: McpBindingSession,
  requested: unknown,
  allowRevisionDrift = false,
): EditorBinding {
  if (session.offline) {
    throw new ExternalEditorCallError('rejected', 'This MCP session is offline-bound and cannot switch binding modes.');
  }
  const projectId = requestedProjectId(requested) ?? session.binding?.projectId ?? defaultBrowserProjectId();
  if (session.binding) {
    if (session.binding.projectId !== projectId) {
      throw new ExternalEditorCallError(
        'rejected',
        `This MCP session is bound to project ${session.binding.projectId}; it cannot operate project ${projectId}.`,
      );
    }
    return validateBrowserBinding(session, allowRevisionDrift)!;
  }
  const binding = editorBinding(projectId);
  if (!binding || !editorBindingMatches(binding)) {
    throw new ExternalEditorCallError('rejected', `Project ${projectId} is not open in a connected OpenChatCut editor.`);
  }
  session.binding = binding;
  return binding;
}

export async function targetMcpProject(
  session: McpBindingSession,
  projectId: string,
  editorUrl: string,
): Promise<McpTargetBinding> {
  if (!VALID_STORED_PROJECT_ID.test(projectId)) {
    throw new ExternalEditorCallError('rejected', 'projectId is invalid');
  }
  const currentProjectId = boundProjectId(session);
  if (currentProjectId && currentProjectId !== projectId) {
    throw new ExternalEditorCallError(
      'rejected',
      `This MCP session is bound to project ${currentProjectId}; it cannot operate project ${projectId}.`,
    );
  }
  if (session.binding) {
    const browser = editorBinding(projectId);
    if (!browser || !editorBindingMatches(browser)) {
      throw new ExternalEditorCallError('rejected', `Project ${projectId} is not open in a connected OpenChatCut editor.`);
    }
    if (session.id) orphanStaleEditorSessions(session.id, browser);
    session.binding = browser;
    session.staleReason = null;
    return browser;
  }
  if (session.offline) {
    await validateOfflineBinding(session);
    return session.offline.binding();
  }
  const browser = editorBinding(projectId);
  if (browser && editorBindingMatches(browser)) {
    session.binding = browser;
    return browser;
  }
  session.offline = await OfflineExternalEditRuntime.create(projectId, editorUrl);
  return session.offline.binding();
}

export function projectForRead(session: McpBindingSession, requested: unknown): string {
  const currentProjectId = boundProjectId(session);
  const projectId = requestedProjectId(requested) ?? currentProjectId ?? defaultBrowserProjectId();
  if (currentProjectId && currentProjectId !== projectId) {
    throw new ExternalEditorCallError(
      'rejected',
      `This MCP session is bound to project ${currentProjectId}; it cannot address project ${projectId}.`,
    );
  }
  return projectId;
}
