import { useEffect } from 'react';

/**
 * Warm lazily-imported chunks once the browser is idle.
 *
 * Code-splitting a dialog off the critical path trades download size for a
 * stall on first open. Fetching the chunk while the user is reading the screen
 * they already have buys back the stall without putting the bytes in front of
 * the first paint.
 *
 * Pass the same `import()` thunks the lazy components use — module fetches are
 * cached by the loader, so the later real import resolves from memory.
 *
 * @param loaders dynamic-import thunks to warm. Treated as fixed for the
 *   component's lifetime: they are read once when the effect runs.
 */
export function useIdlePrefetch(loaders: ReadonlyArray<() => Promise<unknown>>): void {
  useEffect(() => {
    const warm = () => {
      for (const load of loaders) {
        // A failed prefetch is not an error worth surfacing: the real import on
        // open retries and reports the failure where the user can act on it.
        void load().catch(() => {});
      }
    };
    if (typeof requestIdleCallback !== 'function') {
      const timer = setTimeout(warm, 3_000);
      return () => clearTimeout(timer);
    }
    const handle = requestIdleCallback(warm, { timeout: 5_000 });
    return () => cancelIdleCallback(handle);
    // The loader list is a module-level constant at every call site; re-running
    // on identity change would re-fetch for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
