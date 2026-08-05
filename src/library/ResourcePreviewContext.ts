// Resource preview cleanup context — split from ResourceBrowser.tsx so that
// file only exports components (react only-export-components).
import { createContext, useContext, useEffect } from 'react';

export type PreviewCleanup = () => void;
export type RegisterPreviewCleanup = (cleanup: PreviewCleanup) => void;

export const PreviewCleanupContext = createContext<RegisterPreviewCleanup | null>(null);

export function useResourcePreviewCleanup(cleanup: PreviewCleanup): void {
  const register = useContext(PreviewCleanupContext);
  useEffect(() => {
    register?.(cleanup);
  }, [cleanup, register]);
}
