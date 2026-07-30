import { useCallback, useState } from 'react';
import { TranscriptionError, transcribePath, type TranscribeOptions, type TranscriptionProgress } from './assemblyai';
import type { TranscriptResult, TranscriptStatus } from './types';
import { t } from '../i18n/locale';

function transcriptErrorMessage(error: unknown): string {
  if (error instanceof TranscriptionError) {
    return error.code === 'source-unavailable'
      ? t('素材文件不可用，请在“我的素材”中重新链接后再转写')
      : t('无法连接转写服务，请检查网络和 AssemblyAI 配置后重试');
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
  const [progressLog, setProgressLog] = useState<string[]>([]);

  const reportProgress = (label: string | undefined, event: TranscriptionProgress) => {
    const phase = {
      'extracting-audio': t('正在提取语音音轨…'),
      'loading-audio': t('正在读取语音音轨…'),
      'uploading-audio': t('正在上传音频到 AssemblyAI…'),
      'creating-job': t('正在创建 AssemblyAI 转写任务…'),
      queued: t('AssemblyAI 已排队，等待处理…'),
      processing: t('AssemblyAI 正在转写…'),
      completed: t('AssemblyAI 转写完成'),
    }[event.phase];
    const message = `${label ? `${label}: ` : ''}${phase}${event.detail ? ` (${event.detail})` : ''}`;
    setStatus(event.phase === 'queued' || event.phase === 'processing' || event.phase === 'completed' ? 'processing' : 'uploading');
    setProgressNote(message);
    setProgressLog((current) => [...current, `${new Date().toLocaleTimeString()} ${message}`].slice(-12));
  };

  const reset = useCallback(() => {
    setStatus('idle');
    setResult(null);
    setError(null);
    setActiveItemId(null);
    setProgressNote(null);
    setProgressLog([]);
  }, []);

  const run = useCallback(async (
    path: string,
    opts?: TranscribeOptions & { itemId?: string; label?: string },
  ) => {
    setStatus('uploading');
    setError(null);
    setResult(null);
    setActiveItemId(opts?.itemId ?? null);
    setProgressNote(opts?.label ? t('上传 {label}…', { label: opts.label }) : t('上传音频…'));
    try {
      const r = await transcribePath(
        path,
        { languageCode: opts?.languageCode, onProgress: (event) => reportProgress(opts?.label, event) },
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
    setProgressLog([]);
    let last: TranscriptResult | null = null;
    const failures: string[] = [];
    let ok = 0;
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i]!;
      setActiveItemId(job.itemId);
      setStatus('uploading');
      setProgressNote(t('({i}/{total}) 上传 {label}…', { i: i + 1, total: jobs.length, label: job.label }));
      try {
          const r = await transcribePath(
            job.path,
            { ...opts, onProgress: (event) => reportProgress(`(${i + 1}/${jobs.length}) ${job.label}`, event) },
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
      setError(t('已完成 {ok}/{total} 段；失败：{fails}', { ok, total: jobs.length, fails: failures.join('；') }));
      setStatus('done');
    } else {
      setStatus('done');
      setError(null);
    }
    return last;
  }, []);

  return { status, result, error, activeItemId, progressNote, progressLog, run, runMany, reset };
}
