import type { ApprovalDetail } from './approval-details';
import { digestAgentToolArgs } from './runtime-ledger';

export interface ExternalApprovalBinding {
  readonly guardId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly tool: string;
  readonly argsDigest: string;
  readonly operationId?: string;
  readonly summary: string;
  readonly details: readonly ApprovalDetail[];
}

export type PersistExternalApprovalPending = (
  binding: Omit<ExternalApprovalBinding, 'guardId'>,
) => Promise<string>;

export type PersistExternalApprovalResolution = (
  binding: ExternalApprovalBinding,
  allow: boolean,
) => Promise<void>;

function approvalKey(binding: Pick<
  ExternalApprovalBinding,
  'sessionId' | 'runId' | 'tool' | 'argsDigest' | 'operationId'
>): string {
  return [
    binding.sessionId,
    binding.runId,
    binding.tool,
    binding.argsDigest,
    binding.operationId ?? '',
  ].join('\u0000');
}

/**
 * One-shot confirmation state for connected external tools. Durable callbacks
 * are awaited before state becomes visible, so a transport retry cannot race a
 * pending/resolved approval write. Historical approvals never restore access.
 */
export class ExternalApprovalGate {
  private readonly pendingById = new Map<string, ExternalApprovalBinding>();
  private readonly allowedByKey = new Map<string, ExternalApprovalBinding>();

  async request(
    input: Omit<ExternalApprovalBinding, 'guardId'>,
    persist: PersistExternalApprovalPending,
  ): Promise<ExternalApprovalBinding> {
    const guardId = await persist(input);
    const binding: ExternalApprovalBinding = { ...input, guardId };
    this.pendingById.set(guardId, binding);
    return binding;
  }

  async resolve(
    guardId: string,
    allow: boolean,
    persist: PersistExternalApprovalResolution,
  ): Promise<boolean> {
    const binding = this.pendingById.get(guardId);
    if (!binding) return false;
    await persist(binding, allow);
    this.pendingById.delete(guardId);
    if (allow) this.allowedByKey.set(approvalKey(binding), binding);
    return true;
  }

  async consume(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly operationId?: string;
  }): Promise<ExternalApprovalBinding | null> {
    const argsDigest = await digestAgentToolArgs({ ...input.args });
    const key = approvalKey({ ...input, argsDigest });
    const binding = this.allowedByKey.get(key) ?? null;
    if (binding) this.allowedByKey.delete(key);
    return binding;
  }

  pending(): ExternalApprovalBinding | null {
    return this.pendingById.values().next().value ?? null;
  }

  pendingForSession(sessionId: string): ExternalApprovalBinding[] {
    return [...this.pendingById.values()].filter((binding) => binding.sessionId === sessionId);
  }

  clearSessionAllowances(sessionId: string): void {
    for (const [key, binding] of this.allowedByKey) {
      if (binding.sessionId === sessionId) this.allowedByKey.delete(key);
    }
  }

  clear(): void {
    this.pendingById.clear();
    this.allowedByKey.clear();
  }
}
