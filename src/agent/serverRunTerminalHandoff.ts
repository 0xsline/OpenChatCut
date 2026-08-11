import type {
  ServerRunTerminalHandoff,
  ServerRunTerminalResolution,
} from './serverRunProtocol';

interface PendingTerminalHandoff {
  readonly runId: string;
  readonly handoff: ServerRunTerminalHandoff;
  readonly onAbandon?: () => void | Promise<void>;
  settling: Promise<void> | null;
}

/** Retains terminal work until model history and proposal exposure both commit. */
export class ServerRunTerminalHandoffs {
  private pending: PendingTerminalHandoff | null = null;

  get(runId: string): ServerRunTerminalHandoff | null {
    return this.pending?.runId === runId ? this.pending.handoff : null;
  }

  retain(
    runId: string,
    resolution: ServerRunTerminalResolution,
    settle: () => void | Promise<void>,
  ): ServerRunTerminalHandoff {
    const existing = this.get(runId);
    if (existing) return existing;
    if (this.pending) throw new Error('Another server run terminal handoff is still pending.');
    const afterModelCommit = typeof resolution === 'object'
      ? resolution.afterModelCommit
      : undefined;
    const onAbandon = typeof resolution === 'object'
      ? resolution.onAbandon
      : undefined;
    let entry: PendingTerminalHandoff;
    const handoff: ServerRunTerminalHandoff = {
      disposition: typeof resolution === 'object'
        ? resolution.disposition
        : resolution,
      afterModelCommit: () => {
        if (entry.settling) return entry.settling;
        const attempt = (async () => {
          if (this.pending !== entry) return;
          await afterModelCommit?.();
          if (this.pending !== entry) return;
          await settle();
          if (this.pending === entry) this.pending = null;
        })();
        entry.settling = attempt.catch((error: unknown) => {
          entry.settling = null;
          throw error;
        });
        return entry.settling;
      },
    };
    entry = { runId, handoff, onAbandon, settling: null };
    this.pending = entry;
    return handoff;
  }

  async clear(runId: string): Promise<void> {
    const entry = this.pending?.runId === runId ? this.pending : null;
    if (!entry) return;
    this.pending = null;
    await entry.onAbandon?.();
  }
}
