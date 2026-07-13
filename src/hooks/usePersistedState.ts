import { useEffect, useState } from 'react';

// useState backed by localStorage: reads the saved value on init, writes on
// change. Errors (private mode / quota / bad JSON) fall back to `initial`.
export function usePersistedState<T>(key: string, initial: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw != null ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore storage errors */
    }
  }, [key, value]);

  return [value, setValue];
}
