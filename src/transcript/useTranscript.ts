import { useCallback, useState } from 'react';
import { TranscriptionError, transcribePath, type TranscribeOptions } from './assemblyai';
import type { TranscriptResult, TranscriptStatus } from './types';
import { t } from '../i18n/locale';

function transcriptErrorMessage(error: unknown): string {
  if (error instanceof TranscriptionError) {
    return error.code === 'source-unavailable'
      ? t('The material file is unavailable, please relink it in "My Materials" and then transcribe it.')
      : t('Unable to connect to the transcription service, please check the network and AssemblyAI Try again after configuring');
  }
  return error instanceof Error ? error.message : String(error);
}

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
    setProgressNote(opts?.label ? t('upload {label}…', { label: opts.label }) : t('Upload audio…'));
    try {
      const r = await transcribePath(
        path,
        () => {
          setStatus('processing');
          setProgressNote(opts?.label ? t('Transcribe {label}…', { label: opts.label }) : t('Transcribing…'));
        },
        { languageCode: opts?.languageCode },
      );
      setResult(r);
      setStatus('done');
      setProgressNote(null);
      return r;
    } catch (e) {
      setError(transcriptErrorMessage(e));
      setStatus('error');
      setProgressNote(null);
      throw e;
    }
  }, []);

  /**
   * Transcribe many clips sequentially. Continues after per-clip failures so
   * one bad segment does not drop the rest of the track (user saw “only one”).
   */
  const runMany = useCallback(async (
    jobs: { path: string; itemId: string; label: string }[],
    onEach: (itemId: string, r: TranscriptResult) => void,
    opts?: TranscribeOptions,
  ) => {
    setError(null);
    setResult(null);
    let last: TranscriptResult | null = null;
    const failures: string[] = [];
    let ok = 0;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      setActiveItemId(job.itemId);
      setStatus('uploading');
      setProgressNote(t('({i}/{total}) upload {label}…', { i: i + 1, total: jobs.length, label: job.label }));
      try {
        const r = await transcribePath(
          job.path,
          () => {
            setStatus('processing');
            setProgressNote(t('({i}/{total}) Transcribe {label}…', { i: i + 1, total: jobs.length, label: job.label }));
          },
          opts,
        );
        last = r;
        setResult(r);
        onEach(job.itemId, r);
        ok += 1;
      } catch (e) {
        const msg = transcriptErrorMessage(e);
        failures.push(`${job.label}: ${msg}`);
        // keep going — partial track is better than abort
      }
    }
    setActiveItemId(null);
    setProgressNote(null);
    if (failures.length && !ok) {
      setError(failures.join('；'));
      setStatus('error');
      throw new Error(failures[0]);
    }
    if (failures.length) {
      setError(t('Completed {ok}/{total} segment; failure:{fails}', { ok, total: jobs.length, fails: failures.join('；') }));
      setStatus('done');
    } else {
      setStatus('done');
      setError(null);
    }
    return last;
  }, []);

  return { status, result, error, activeItemId, progressNote, run, runMany, reset };
}
