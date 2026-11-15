import {
  sameEditorBinding,
  sameEditorIdentity,
} from './broker-registry.ts';
import {
  ExternalEditorCallError,
  type EditorBinding,
} from './broker-types.ts';

interface EditSessionOwner {
  ownerId: string;
  binding: EditorBinding;
}

interface RecoveryClaim extends EditSessionOwner {
  callId: string;
}

export interface EditSessionOwnershipCall {
  id: string;
  ownerId: string;
  binding: EditorBinding;
  name: string;
  arguments: Record<string, unknown>;
}

function sessionIdFrom(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const sessionId = (value as Record<string, unknown>).editSessionId;
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}

function requestedSessionId(call: EditSessionOwnershipCall): string {
  const sessionId = call.arguments.editSessionId;
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}

/**
 * Whether the transport that owns a draft still counts as present when another
 * transport (`claimantId`) contends for it. Returning false lets the claimant
 * recover the draft without waiting for the owner's MCP session to expire.
 */
export type EditSessionOwnerLiveness = (ownerId: string, claimantId: string) => boolean;

export class EditSessionOwnershipRegistry {
  private readonly owners = new Map<string, EditSessionOwner>();
  private readonly orphans = new Map<string, EditorBinding>();
  private readonly recoveryClaims = new Map<string, RecoveryClaim>();

  private ownerLive: EditSessionOwnerLiveness;

  constructor(ownerLive: EditSessionOwnerLiveness = () => true) {
    this.ownerLive = ownerLive;
  }

  setOwnerLiveness(ownerLive: EditSessionOwnerLiveness): void {
    this.ownerLive = ownerLive;
  }

  /**
   * An agent that reconnects on a new MCP transport (crash, client restart,
   * dropped session id) used to be locked out of its own draft until the old
   * transport expired an hour later. When another transport contends for the
   * draft and the owner is no longer live, the draft becomes orphaned and the
   * normal recover/reuse paths apply.
   */
  private orphanIfOwnerGone(sessionId: string, claimantId: string): void {
    const owner = this.owners.get(sessionId);
    if (!owner || owner.ownerId === claimantId || this.ownerLive(owner.ownerId, claimantId)) return;
    this.owners.delete(sessionId);
    this.orphans.set(sessionId, { ...owner.binding });
  }

  owns(ownerId: string, binding: EditorBinding, editSessionId: unknown): boolean {
    if (typeof editSessionId !== 'string') return false;
    const owner = this.owners.get(editSessionId.trim());
    return Boolean(
      owner
      && owner.ownerId === ownerId
      && sameEditorBinding(owner.binding, binding)
    );
  }

  requireOwned(
    ownerId: string,
    binding: EditorBinding,
    editSessionId: unknown,
  ): void {
    if (this.owns(ownerId, binding, editSessionId)) return;
    const sessionId = typeof editSessionId === 'string' ? editSessionId.trim() : '';
    const owner = this.owners.get(sessionId);
    if (owner
      && owner.ownerId === ownerId
      && sameEditorIdentity(owner.binding, binding)
      && owner.binding.baseRevision === binding.baseRevision) {
      owner.binding = { ...binding };
      return;
    }
    throw new ExternalEditorCallError(
      'rejected',
      'The requested edit session does not belong to this MCP transport and editor binding.',
    );
  }

  reserveRecovery(call: EditSessionOwnershipCall): void {
    if (call.name !== 'recover_edit_session') return;
    const sessionId = requestedSessionId(call);
    if (sessionId) this.orphanIfOwnerGone(sessionId, call.ownerId);
    if (!sessionId || !this.orphans.has(sessionId)) {
      throw new ExternalEditorCallError('rejected', 'Only an orphaned edit session can be recovered.');
    }
    if (this.recoveryClaims.has(sessionId)) {
      throw new ExternalEditorCallError(
        'rejected',
        `Edit session ${sessionId} is already being recovered by another MCP transport.`,
      );
    }
    this.recoveryClaims.set(sessionId, {
      callId: call.id,
      ownerId: call.ownerId,
      binding: { ...call.binding },
    });
  }

  finishApplied(call: EditSessionOwnershipCall, value: unknown): unknown {
    if (call.name === 'list_edit_sessions') {
      return this.projectSessionList(call.ownerId, call.binding, value);
    }
    if (call.name === 'begin_edit_session') {
      const sessionId = sessionIdFrom(value);
      if (sessionId) {
        this.orphanIfOwnerGone(sessionId, call.ownerId);
        if (this.owners.has(sessionId)) this.requireOwned(call.ownerId, call.binding, sessionId);
        if (this.recoveryClaims.has(sessionId)) {
          throw new ExternalEditorCallError(
            'rejected', 'The active edit session is already being recovered by another MCP transport.',
          );
        }
        if ((value as Record<string, unknown>).stale === true) {
          throw new ExternalEditorCallError(
            'rejected', 'The active edit session is stale. Call list_edit_sessions before recovery or discard.',
          );
        }
        this.recordOwner(sessionId, call.ownerId, call.binding);
      }
      return value;
    }
    if (call.name !== 'recover_edit_session') return value;
    const sessionId = requestedSessionId(call);
    this.releaseRecovery(call);
    if (!sessionId) return value;
    if (call.arguments.action === 'discard') {
      this.owners.delete(sessionId);
      this.orphans.delete(sessionId);
      return value;
    }
    if (call.arguments.action === 'resume' && sessionIdFrom(value) === sessionId) {
      this.recordOwner(sessionId, call.ownerId, call.binding);
    }
    return value;
  }

  releaseRecovery(call: EditSessionOwnershipCall): void {
    if (call.name !== 'recover_edit_session') return;
    const sessionId = requestedSessionId(call);
    const claim = this.recoveryClaims.get(sessionId);
    if (claim?.callId === call.id) this.recoveryClaims.delete(sessionId);
  }

  disconnectOwner(ownerId: string): void {
    for (const [sessionId, owner] of this.owners) {
      if (owner.ownerId !== ownerId) continue;
      this.owners.delete(sessionId);
      this.orphans.set(sessionId, { ...owner.binding });
    }
  }

  orphanStaleOwnedSessions(ownerId: string, binding: EditorBinding): void {
    for (const [sessionId, owner] of this.owners) {
      if (owner.ownerId !== ownerId) continue;
      if (sameEditorIdentity(owner.binding, binding) && owner.binding.baseRevision === binding.baseRevision) {
        owner.binding = { ...binding };
        continue;
      }
      this.owners.delete(sessionId);
      this.orphans.set(sessionId, { ...owner.binding });
    }
  }

  reset(): void {
    this.owners.clear();
    this.orphans.clear();
    this.recoveryClaims.clear();
  }

  private recordOwner(sessionId: string, ownerId: string, binding: EditorBinding): void {
    this.owners.set(sessionId, { ownerId, binding: { ...binding } });
    this.orphans.delete(sessionId);
  }

  private projectSessionList(ownerId: string, binding: EditorBinding, value: unknown): unknown {
    if (!Array.isArray(value)) return value;
    return value.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
      const record = entry as Record<string, unknown>;
      const sessionId = typeof record.editSessionId === 'string' ? record.editSessionId : '';
      if (sessionId) this.orphanIfOwnerGone(sessionId, ownerId);
      const owner = this.owners.get(sessionId);
      const active = record.status === 'drafting' || record.status === 'awaiting_review';
      const orphaned = active && (this.orphans.has(sessionId) || !owner);
      if (orphaned && !this.orphans.has(sessionId)) this.orphans.set(sessionId, { ...binding });
      const recoveryPending = this.recoveryClaims.has(sessionId);
      return {
        ...record,
        ownerOnline: Boolean(owner),
        orphaned,
        recoveryPending,
        recoveryActions: orphaned && !recoveryPending
          ? (record.stale === true ? ['discard'] : ['resume', 'discard'])
          : [],
        // Identity, not epoch: a lease renewal alone must not make an agent
        // believe it lost a draft it still owns.
        ownedByCurrentTransport: owner?.ownerId === ownerId
          && sameEditorIdentity(owner.binding, binding),
      };
    });
  }
}
