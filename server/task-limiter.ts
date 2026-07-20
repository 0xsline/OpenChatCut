export type ReleaseTaskPermit = () => void;

interface WaitingTask {
  resolve: (release: ReleaseTaskPermit) => void;
}

/** FIFO limiter for expensive local work such as Remotion exports. */
export class TaskLimiter {
  private active = 0;
  private readonly waiting: WaitingTask[] = [];

  private readonly limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError('task limiter limit must be a positive integer');
    }
    this.limit = limit;
  }

  acquire(): Promise<ReleaseTaskPermit> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve) => this.waiting.push({ resolve }));
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  snapshot(): { active: number; queued: number; limit: number } {
    return { active: this.active, queued: this.waiting.length, limit: this.limit };
  }

  private releaseOnce(): ReleaseTaskPermit {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) {
        next.resolve(this.releaseOnce());
        return;
      }
      this.active -= 1;
    };
  }
}
