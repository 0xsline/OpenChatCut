import { useCallback, useState } from 'react';
import { transcribePath, type TranscribeOptions } from './assemblyai';
import type { TranscriptResult, TranscriptStatus } from './types';

// Drives transcription against a same-origin media path.
// Never falls back to a demo sample — caller must pass a real clip src.
export function useTranscript() {
  const [status, setStatus] = useState<TranscriptStatus>('idle');
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [progressNote, setProgressNote] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStatus('idle');
    setResult(null);
    setError(null);
    setActiveItemId(null);
    setProgressNote(null);
  }, []);

  const run = useCallback(async (
    path: string,
    opts?: TranscribeOptions & { itemId?: string; label?: string },
  ) => {
    setStatus('uploading');
    setError(null);
    setResult(null);
    setActiveItemId(opts?.itemId ?? null);
    setProgressNote(opts?.label ? `上传 ${opts.label}…` : '上传音频…');
    try {
      const r = await transcribePath(
        path,
        () => {
          setStatus('processing');
          setProgressNote(opts?.label ? `转写 ${opts.label}…` : '转写中…');
        },
        { languageCode: opts?.languageCode },
      );
      setResult(r);
      setStatus('done');
      setProgressNote(null);
      return r;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
      setProgressNote(null);
      throw e;
    }
  }, []);

  /** Transcribe many clips sequentially; invokes onEach after each success. */
  const runMany = useCallback(async (
    jobs: { path: string; itemId: string; label: string }[],
    onEach: (itemId: string, r: TranscriptResult) => void,
    opts?: TranscribeOptions,
  ) => {
    setError(null);
    setResult(null);
    let last: TranscriptResult | null = null;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      setActiveItemId(job.itemId);
      setStatus('uploading');
      setProgressNote(`(${i + 1}/${jobs.length}) 上传 ${job.label}…`);
      try {
        const r = await transcribePath(
          job.path,
          () => {
            setStatus('processing');
            setProgressNote(`(${i + 1}/${jobs.length}) 转写 ${job.label}…`);
          },
          opts,
        );
        last = r;
        setResult(r);
        onEach(job.itemId, r);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
        setProgressNote(null);
        throw e;
      }
    }
    setStatus('done');
    setProgressNote(null);
    setActiveItemId(null);
    return last;
  }, []);

  return { status, result, error, activeItemId, progressNote, run, runMany, reset };
}
