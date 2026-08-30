// Pointers report faster than the display refreshes — commonly 120 Hz or more
// against a 60 Hz screen, and the browser delivers each report in its own task,
// so React commits once per report rather than once per painted frame. Every
// commit but the last in a frame is thrown away before anything is shown.
//
// A coalescer keeps only the newest value and applies it once per frame.
// The scheduler is injected so the behaviour can be tested without a browser.

export interface FrameCoalescer<T> {
  /** Replace any pending value; it is applied on the next scheduled frame. */
  schedule(value: T, apply: (value: T) => void): void;
  /** Drop the pending value and any scheduled frame. */
  cancel(): void;
  /** True while a frame is scheduled but has not run. */
  readonly pending: boolean;
}

/**
 * Coalesce a stream of values to at most one application per frame.
 *
 * `apply` is passed per call rather than up front because callers are React
 * components: the newest callback closes over the newest state, and the flush
 * must use that one rather than whichever closure happened to arrive first.
 */
export function createFrameCoalescer<T>(
  scheduleFrame: (callback: () => void) => number,
  cancelFrame: (handle: number) => void,
): FrameCoalescer<T> {
  let handle = 0;
  let next: { value: T; apply: (value: T) => void } | null = null;

  return {
    schedule(value, apply) {
      next = { value, apply };
      if (handle) return;
      handle = scheduleFrame(() => {
        handle = 0;
        const flush = next;
        next = null;
        // A throw here must not wedge the coalescer: `handle` and `next` are
        // already cleared, so the following value still schedules a frame.
        if (flush) flush.apply(flush.value);
      });
    },
    cancel() {
      if (handle) cancelFrame(handle);
      handle = 0;
      next = null;
    },
    get pending() {
      return handle !== 0;
    },
  };
}
