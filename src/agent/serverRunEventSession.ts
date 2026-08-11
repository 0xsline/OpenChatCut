import type { ServerRunEventStream } from './serverRunFetchEventStream';
import { serverRunRecoveryDelay } from './serverRunRecovery';

/** Owns the browser fetch event stream and reconnect timer for one hook instance. */
export class ServerRunEventSession {
  private source: ServerRunEventStream | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private recoveryAttempt = 0;
  private readonly reconnect: (runId: string) => void;

  constructor(reconnect: (runId: string) => void) {
    this.reconnect = reconnect;
  }

  beginConnection(): number {
    this.close();
    return this.epoch;
  }

  isCurrent(epoch: number): boolean {
    return epoch === this.epoch;
  }

  close(): void {
    this.epoch += 1;
    this.source?.close();
    this.source = null;
    this.clearReconnectTimer();
  }

  attach(source: ServerRunEventStream, epoch: number): boolean {
    if (!this.isCurrent(epoch)) {
      source.close();
      return false;
    }
    this.source = source;
    return true;
  }

  retry(runId: string): void {
    this.source?.close();
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => this.reconnect(runId), 250);
  }

  scheduleReconnect(runId: string): void {
    this.scheduleRecovery(() => this.reconnect(runId));
  }

  scheduleRecovery(recover: () => void): void {
    this.clearReconnectTimer();
    const delay = serverRunRecoveryDelay(this.recoveryAttempt++);
    this.reconnectTimer = setTimeout(recover, delay);
  }

  handleTransportError(source: ServerRunEventStream, runId: string): void {
    if (this.source !== source) return;
    source.close();
    this.source = null;
    this.scheduleReconnect(runId);
  }

  markOpened(source: ServerRunEventStream): void {
    if (this.source === source) this.resetRecovery();
  }

  resetRecovery(): void {
    this.recoveryAttempt = 0;
  }

  private clearReconnectTimer(): void {
    clearTimeout(this.reconnectTimer ?? undefined);
    this.reconnectTimer = null;
  }
}
