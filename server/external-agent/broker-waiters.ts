export type BrokerWaiters = Map<string, Set<() => void>>;

export function wakeBrokerWaiters(waiters: BrokerWaiters, key: string): void {
  for (const waiter of waiters.get(key) ?? []) waiter();
}

export function waitForBrokerWake(
  waiters: BrokerWaiters,
  key: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      const listeners = waiters.get(key);
      listeners?.delete(finish);
      if (!listeners?.size) waiters.delete(key);
      resolve();
    };
    const listeners = waiters.get(key) ?? new Set<() => void>();
    listeners.add(finish);
    waiters.set(key, listeners);
    const timer = setTimeout(finish, timeoutMs);
    signal.addEventListener('abort', finish, { once: true });
  });
}
