export class NativeAsrWorkerLifecycle {
  private terminal = false;
  private queue = Promise.resolve();

  isTerminal(): boolean {
    return this.terminal;
  }

  terminate(): void {
    this.terminal = true;
  }

  enqueue(task: () => Promise<void>): void {
    if (this.terminal) return;
    const run = () => this.terminal ? undefined : task();
    this.queue = this.queue.then(run, run);
  }
}
