import { useCallback, useEffect, useRef, useState } from 'react';
import {
  chooseExportDestination,
  DEFAULT_EXPORT_DESTINATION,
  restoreExportDestination,
  type ExportDestination,
} from './exportDestination';

export function exportDestinationMatchesFilename(
  destination: ExportDestination,
  selectedFilename: string | undefined,
  suggestedFilename: string | undefined,
): boolean {
  if (destination.type === 'browser-file' || destination.type === 'desktop-file') {
    return selectedFilename === suggestedFilename;
  }
  const directory = destination.type === 'browser-directory' || destination.type === 'desktop-directory';
  return !directory || suggestedFilename === undefined;
}

export function useExportDestination(suggestedFilename?: string) {
  const [destination, setDestination] = useState<ExportDestination>(DEFAULT_EXPORT_DESTINATION);
  const [choosingDestination, setChoosingDestination] = useState(false);
  const interactedRef = useRef(false);
  const fileSelectionKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    void restoreExportDestination().then((restored) => {
      if (!active || interactedRef.current) return;
      const directory = restored.type === 'browser-directory' || restored.type === 'desktop-directory';
      const compatible = suggestedFilename && directory ? DEFAULT_EXPORT_DESTINATION : restored;
      setDestination(compatible);
    }).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [suggestedFilename]);

  const activeDestination = exportDestinationMatchesFilename(
    destination,
    fileSelectionKeyRef.current,
    suggestedFilename,
  ) ? destination : DEFAULT_EXPORT_DESTINATION;

  useEffect(() => {
    if (activeDestination !== destination) setDestination(DEFAULT_EXPORT_DESTINATION);
  }, [activeDestination, destination]);

  const chooseDestination = useCallback(async () => {
    interactedRef.current = true;
    setChoosingDestination(true);
    try {
      const selected = await chooseExportDestination(suggestedFilename);
      if (selected) {
        const fileDestination = selected.type === 'browser-file' || selected.type === 'desktop-file';
        fileSelectionKeyRef.current = fileDestination ? suggestedFilename : undefined;
        setDestination(selected);
      }
      return selected;
    } finally {
      setChoosingDestination(false);
    }
  }, [suggestedFilename]);

  return { chooseDestination, choosingDestination, destination: activeDestination };
}
