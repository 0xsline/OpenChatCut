import { useCallback, useState } from 'react';
import { transcribePath } from './assemblyai';
import type { TranscriptResult, TranscriptStatus } from './types';

// Drives one transcription run against a same-origin audio path.
export function useTranscript() {
  const [status, setStatus] = useState<TranscriptStatus>('idle');
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (path: string) => {
    setStatus('uploading');
    setError(null);
    setResult(null);
    try {
      const r = await transcribePath(path, () => setStatus('processing'));
      setResult(r);
      setStatus('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, []);

  return { status, result, error, run };
}
