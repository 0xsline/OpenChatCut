import {
  cancelEditorCallsForOwner,
  connectedProjectIds,
  editorBinding,
  editorBindingIdentityMatches,
  editorBindingMatches,
  ExternalEditorCallError,
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

export function validateBrowserBinding(
  session: McpBindingSession,
  allowRevisionDrift = false,
  adoptSameIdentity = true,
): EditorBinding | null {
  if (session.staleReason) throw new ExternalEditorCallError('stale', session.staleReason);
  if (!session.binding) return null;
  const matches = allowRevisionDrift
    ? editorBindingIdentityMatches(session.binding)
    : editorBindingMatches(session.binding);
  if (matches) return session.binding;
  // A same-editor revision advance between bind and an editor tool call (an
  // autosave landing, a tool settle syncing the registry) is a legitimate
  // progression, not a stale takeover: re-bind to the registry's current
  // snapshot instead of poisoning the whole session. Control/status tools keep
  // the strict check so a replaced binding is still reported as stale there.
  const current = editorBinding(session.binding.projectId);
  if (adoptSameIdentity
    && current
    && sameEditorIdentity(current, session.binding)
    && editorBindingMatches(current)) {
    session.binding = current;
    return current;
  }
  const message = `MCP session binding for project ${session.binding.projectId} is stale. Re-initialize the MCP session.`;
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
  if (session.binding) return validateBrowserBinding(session)!;
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
