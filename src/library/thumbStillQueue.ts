type PreviewStillTask = {
  cancelled: boolean;
  load: () => Promise<string>;
  onReady: (url: string) => void;
};

const queue: PreviewStillTask[] = [];
let scheduled = false;
let running = false;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
};

function scheduleNext(): void {
  if (scheduled || running || queue.length === 0) return;
  scheduled = true;
  const start = () => {
    scheduled = false;
    void runNext();
  };
  const idleWindow = window as IdleWindow;
  if (idleWindow.requestIdleCallback) {
    idleWindow.requestIdleCallback(start, { timeout: 250 });
  } else {
    window.setTimeout(start, 32);
  }
}

async function runNext(): Promise<void> {
  while (queue[0]?.cancelled) queue.shift();
  const task = queue.shift();
  if (!task) return;
  running = true;
  try {
    const url = await task.load();
    if (!task.cancelled && url) task.onReady(url);
  } catch {
    // A failed thumbnail keeps the card's existing placeholder.
  } finally {
    running = false;
    window.setTimeout(scheduleNext, 16);
  }
}

export function schedulePreviewStill(
  load: () => Promise<string>,
  onReady: (url: string) => void,
): () => void {
  const task: PreviewStillTask = { cancelled: false, load, onReady };
  queue.push(task);
  scheduleNext();
  return () => { task.cancelled = true; };
}
