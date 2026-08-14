import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  releaseProjectEditOwnership,
  renewProjectEditOwnership,
  type ProjectEditOwnershipClaim,
} from './project-edit-ownership.ts';
import {
  ExternalEditorCallError,
  type EditorBinding,
  type ExternalToolSchema,
} from './broker-types.ts';

const ONLINE_MS = 35_000;

function capabilityMatches(actual: string, candidate: string | null | undefined): boolean {
  if (typeof candidate !== 'string' || candidate.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(candidate));
}

interface EditorRegistration extends EditorBinding {
  lastSeen: number;
  tools: ExternalToolSchema[];
  ownership?: ProjectEditOwnershipClaim;
  capability: string;
}

export interface EditorConnectionRegistryHooks {
  bindingReplaced: (binding: EditorBinding, sameEditor: boolean) => void;
  revisionChanged: (binding: EditorBinding) => void;
  editorRemoved: (binding: EditorBinding) => void;
  wakeProject: (projectId: string) => void;
  hasInFlightCall: (projectId: string) => boolean;
}

export function sameEditorBinding(left: EditorBinding, right: EditorBinding): boolean {
  return left.projectId === right.projectId
    && left.editorInstanceId === right.editorInstanceId
    && left.baseRevision === right.baseRevision
    && left.ownershipEpoch === right.ownershipEpoch;
}

export function sameEditorIdentity(left: EditorBinding, right: EditorBinding): boolean {
  return left.projectId === right.projectId
    && left.editorInstanceId === right.editorInstanceId;
}

function bindingOf(editor: EditorRegistration): EditorBinding {
  return {
    projectId: editor.projectId,
    editorInstanceId: editor.editorInstanceId,
    baseRevision: editor.baseRevision,
    ...(editor.ownershipEpoch === undefined ? {} : { ownershipEpoch: editor.ownershipEpoch }),
  };
}

function validateOwnershipClaim(
  ownership: ProjectEditOwnershipClaim | undefined,
  binding: EditorBinding,
): void {
  if (!ownership) return;
  if (
    ownership.projectId !== binding.projectId
    || ownership.ownerKind !== 'browser'
    || ownership.ownerId !== binding.editorInstanceId
    || ownership.baseRevision !== binding.baseRevision
  ) throw new Error('editor ownership claim does not match registration');
}

function bindingChanged(
  previous: EditorRegistration,
  editorInstanceId: string,
  baseRevision: string,
  ownershipEpoch: number | undefined,
): boolean {
  return previous.editorInstanceId !== editorInstanceId
    || previous.baseRevision !== baseRevision
    || previous.ownershipEpoch !== ownershipEpoch;
}

export class EditorConnectionRegistry {
  private readonly editors = new Map<string, EditorRegistration>();
  private readonly listeners = new Set<() => void>();
  private readonly hooks: EditorConnectionRegistryHooks;

  constructor(hooks: EditorConnectionRegistryHooks) {
    this.hooks = hooks;
  }

  register(
    projectId: string,
    editorInstanceId: string,
    baseRevision: string,
    tools: ExternalToolSchema[],
    ownership?: ProjectEditOwnershipClaim,
    registrationCapability?: string | null,
  ): string {
    const before = JSON.stringify(this.tools());
    const previous = this.editors.get(projectId);
    const trustedInternalCall = registrationCapability === undefined;
    const validRenewal = Boolean(
      previous
      && previous.editorInstanceId === editorInstanceId
      && capabilityMatches(previous.capability, registrationCapability),
    );
    if (!trustedInternalCall && registrationCapability && !validRenewal) {
      throw new ExternalEditorCallError('stale', 'Editor registration capability is stale.');
    }
    // A different browser window may take over the active connection for the
    // same project. Single-window desktop users never open one project in two
    // windows, but a reloaded/fresh window (a new random editor id) must be able
    // to (re)connect without a persistent "already has an active editor"
    // rejection. The old entry is replaced below by this.editors.set, and the
    // persisted ownership claim (validated at validateOwnershipClaim) still
    // fences stale takeovers. Offline/multi-writer safety comes from the
    // serialized project-store mutations and the ownership epoch checks.
    validateOwnershipClaim(ownership, { projectId, editorInstanceId, baseRevision });
    const ownershipEpoch = ownership?.epoch;
    if (previous && bindingChanged(previous, editorInstanceId, baseRevision, ownershipEpoch)) {
      this.hooks.bindingReplaced(bindingOf(previous), previous.editorInstanceId === editorInstanceId);
    }
    const capability = validRenewal || trustedInternalCall && previous
      ? previous!.capability
      : randomBytes(32).toString('base64url');
    this.editors.set(projectId, {
      projectId,
      editorInstanceId,
      baseRevision,
      lastSeen: Date.now(),
      ownershipEpoch,
      ownership,
      capability,
      tools,
    });
    this.announceIfChanged(before);
    this.hooks.wakeProject(projectId);
    return capability;
  }

  async unregister(
    projectId: string,
    editorInstanceId: string,
    registrationCapability?: string | null,
  ): Promise<boolean> {
    const editor = this.editors.get(projectId);
    if (!editor || editor.editorInstanceId !== editorInstanceId) return false;
    if (registrationCapability !== undefined
      && !capabilityMatches(editor.capability, registrationCapability)) return false;
    const before = JSON.stringify(this.tools());
    const binding = bindingOf(editor);
    this.editors.delete(projectId);
    this.hooks.editorRemoved(binding);
    this.announceIfChanged(before);
    this.hooks.wakeProject(projectId);
    if (editor.ownership) await releaseProjectEditOwnership(editor.ownership);
    return true;
  }

  async touch(
    projectId: string,
    editorInstanceId: string,
    baseRevision?: string,
    registrationCapability?: string | null,
  ): Promise<boolean> {
    const editor = this.editors.get(projectId);
    if (!editor || editor.editorInstanceId !== editorInstanceId) return false;
    if (registrationCapability !== undefined
      && !capabilityMatches(editor.capability, registrationCapability)) return false;
    if (editor.ownership) {
      const renewed = await renewProjectEditOwnership(editor.ownership, baseRevision ?? editor.baseRevision);
      if (renewed.status !== 'renewed') {
        await this.unregister(projectId, editorInstanceId);
        throw new ExternalEditorCallError('stale', `Project ${projectId} browser ownership is stale.`);
      }
      editor.ownership = renewed.claim;
      editor.ownershipEpoch = renewed.claim.epoch;
      // The store is the authority for the committed revision: a tool result may
      // settle before autosave lands, so the browser-reported doc revision can
      // run ahead of the store. Adopting the renewed claim's store revision keeps
      // the registry consistent with what a follow-up MCP session will bind to.
      editor.baseRevision = renewed.claim.baseRevision;
    } else if (baseRevision && editor.baseRevision !== baseRevision) {
      const previous = bindingOf(editor);
      editor.baseRevision = baseRevision;
      this.hooks.revisionChanged(previous);
    }
    // A successful touch IS the keep-alive: refresh lastSeen so the online
    // lease (isConnected) reflects this poll even when no call arrives.
    editor.lastSeen = Date.now();
    return true;
}

  registrationMatches(
    projectId: string,
    editorInstanceId: string,
    registrationCapability: string | null | undefined,
  ): boolean {
    const editor = this.editors.get(projectId);
    return Boolean(
      editor
      && editor.editorInstanceId === editorInstanceId
      && capabilityMatches(editor.capability, registrationCapability),
    );
  }

  binding(projectId: string): EditorBinding | null {
    const editor = this.editors.get(projectId);
    return editor ? bindingOf(editor) : null;
  }

  bindingMatches(binding: EditorBinding): boolean {
    const current = this.binding(binding.projectId);
    return Boolean(current && sameEditorBinding(current, binding) && this.isConnected(binding.projectId));
  }

  identityMatches(binding: EditorBinding): boolean {
    const current = this.binding(binding.projectId);
    return Boolean(current && sameEditorIdentity(current, binding) && this.isConnected(binding.projectId));
  }

  connectedProjectIds(): string[] {
    const now = Date.now();
    return [...this.editors.keys()].filter((projectId) => this.isConnected(projectId, now));
  }

  isConnected(projectId: string, now = Date.now()): boolean {
    const editor = this.editors.get(projectId);
    if (!editor) return false;
    return now - editor.lastSeen < ONLINE_MS || this.hooks.hasInFlightCall(projectId);
  }

  statuses(): Array<{
    projectId: string;
    editorId: string;
    baseRevision: string;
    connected: boolean;
    toolCount: number;
  }> {
    const now = Date.now();
    return [...this.editors.entries()].map(([projectId, editor]) => ({
      projectId,
      editorId: editor.editorInstanceId,
      baseRevision: editor.baseRevision,
      connected: this.isConnected(projectId, now),
      toolCount: editor.tools.length,
    }));
  }

  tools(): ExternalToolSchema[] {
    return this.editors.values().next().value?.tools ?? [];
  }

  onToolsChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.editors.clear();
  }

  private announceIfChanged(before: string): void {
    if (JSON.stringify(this.tools()) === before) return;
    for (const listener of this.listeners) listener();
  }
}
