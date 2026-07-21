import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { getLocale } from '../i18n/locale';
import {
  closeMobileUploadSession,
  createMobileUploadSession,
  getMobileUploadSession,
  type MobileUploadRecord,
  type MobileUploadSession,
} from './mobileUploadApi';

const POLL_INTERVAL_MS = 800;

type SetSession = Dispatch<SetStateAction<MobileUploadSession | null>>;
type SetError = Dispatch<SetStateAction<string | null>>;

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function useCreatedSession(setError: SetError): [MobileUploadSession | null, SetSession] {
  const [session, setSession] = useState<MobileUploadSession | null>(null);
  useEffect(() => {
    let active = true;
    let createdId: string | null = null;
    void createMobileUploadSession(getLocale()).then((created) => {
      createdId = created.id;
      if (!active) { void closeMobileUploadSession(created.id).catch(() => undefined); return; }
      setSession(created);
    }).catch((reason: unknown) => { if (active) setError(messageOf(reason)); });
    return () => {
      active = false;
      if (createdId) void closeMobileUploadSession(createdId).catch(() => undefined);
    };
  }, [setError]);
  return [session, setSession];
}

function useImporter(onImport: (record: MobileUploadRecord) => Promise<void>, setError: SetError) {
  const importedIds = useRef(new Set<string>());
  const [imported, setImported] = useState(0);
  const importFiles = useCallback(async (files: MobileUploadRecord[]) => {
    for (const file of files) {
      if (importedIds.current.has(file.id)) continue;
      try {
        await onImport(file);
        importedIds.current.add(file.id);
        setImported((count) => count + 1);
      } catch (reason) {
        setError(messageOf(reason));
      }
    }
  }, [onImport, setError]);
  return { imported, importFiles };
}

function useSessionActions(session: MobileUploadSession | null, setSession: SetSession, importFiles: (files: MobileUploadRecord[]) => Promise<void>, setError: SetError) {
  const inFlight = useRef<Promise<void> | null>(null);
  const finished = useRef(false);
  const refresh = useCallback(async () => {
    if (!session?.id || finished.current) return;
    if (inFlight.current) return inFlight.current;
    const task = getMobileUploadSession(session.id).then(async (next) => {
      setSession(next);
      await importFiles(next.files);
    }).catch((reason: unknown) => setError(messageOf(reason))).finally(() => { inFlight.current = null; });
    inFlight.current = task;
    return task;
  }, [importFiles, session?.id, setError, setSession]);
  const finish = useCallback(async () => {
    if (!session?.id) return;
    finished.current = true;
    await inFlight.current;
    try {
      const final = await closeMobileUploadSession(session.id);
      setSession(final);
      await importFiles(final.files);
    } catch (reason) {
      setError(messageOf(reason));
    }
  }, [importFiles, session?.id, setError, setSession]);
  return { refresh, finish };
}

function usePolling(refresh: () => Promise<void>): void {
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
}

export function useMobileUploadSession(onImport: (record: MobileUploadRecord) => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useCreatedSession(setError);
  const { imported, importFiles } = useImporter(onImport, setError);
  const { refresh, finish } = useSessionActions(session, setSession, importFiles, setError);
  usePolling(refresh);
  return { session, error, imported, finish };
}
