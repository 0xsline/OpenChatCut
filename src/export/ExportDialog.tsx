// Export settings dialog box (submit_export full parameter surface, 5 tabs):
//   Video codec h264/vp8 + resolution 480/720/1080p + frame rate 24/25/30/50/60 (default and timeline)
//   Audio mp3 (video track ignored)
//   MG animation All MGs are rendered one by one into ProRes 4444 .mov with alpha
//   Subtitles srt / txt (subtitles need to be turned on first)
//   XML fcp_xml(Premiere)/ fcp_xml_resolve(DaVinci)± Render MG .mov with the package
// "Create Sharing Link" (cloud public page) requires a sharing backend - none locally, no false switches.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n/locale';
import { Icon, type IconName } from '../components/icons';
import { captionTrackEntries, timelineDuration, trackAlias, type TimelineState } from '../editor/types';
import { timelineToFcpxml } from './fcpxml';
import { captionsToSrt, captionsToTxt } from '../captions/exportCaptions';
import { exportClipMov, renderClipMovBlob } from '../media/clipExport';
import { sanitizeFileName } from '../media/fileName';
import { motionGraphicRenderFilename, motionGraphicRenderKey } from './motionGraphicRefs';
import { recordExport } from '../persist/exportHistoryStore';

import { exportVideoWithFallback, isAbortError, renderTimelineInBrowser } from './browserExport';
import { EXPORT_FPS_OPTIONS, EXPORT_RESOLUTIONS, type ExportResolution } from './mediaSettings';
import {
  captionLayoutQaIssues,
  exportQaExpectations,
  mergeExportQaIssues,
  timelineCutTimesSeconds,
  type ExportQaIssue,
  type ExportQaReport,
} from './quality';
import {
  loadExportAutoQaPreference,
  runExportQa,
  saveExportAutoQaPreference,
} from './autoQa';


type ExportTab = 'video' | 'audio' | 'mg' | 'subtitles' | 'xml';

interface ExportDialogProps {
  state: TimelineState;
  projectName: string;
  onClose: () => void;
}

const TABS: Array<{ key: ExportTab; label: string; summary: string; icon: IconName }> = [
  { key: 'video', label: 'Completed film', summary: 'MP4 / WebM', icon: 'film' },
  { key: 'audio', label: 'audio track', summary: 'MP3', icon: 'music' },
  { key: 'mg', label: 'Dynamic layers', summary: 'ProRes 4444', icon: 'sparkles' },
  { key: 'subtitles', label: 'Subtitles', summary: 'SRT / TXT', icon: 'captions' },
  { key: 'xml', label: 'Editing project', summary: 'FCPXML', icon: 'clipboard' },
];

const FPS_OPTIONS = [...EXPORT_FPS_OPTIONS];
const RESOLUTIONS = Object.keys(EXPORT_RESOLUTIONS) as ExportResolution[];


type ExportPhase = 'queued' | 'preparing' | 'rendering' | 'finalizing' | 'verifying' | 'downloading' | 'completed' | 'failed' | 'cancelled';
type RenderEngine = 'idle' | 'checking' | 'browser' | 'server';


interface ExportProgress {
  phase: ExportPhase;
  percent: number;
  startedAt: number;
  finishedAt?: number;
  processedFrames?: number;
  totalFrames?: number;
  detail?: string;
  outputSize?: number;
}

interface ExportJobSnapshot {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  progress: number;
  phase?: string;
  processedFrames?: number;
  totalFrames?: number;
  result?: {
    path?: string;
    name?: string;
    sizeBytes?: number;
    codec?: string;
    durationSeconds?: number;
    width?: number;
    height?: number;
    fps?: number;
    sourceStartSeconds?: number;
  };
  error?: string;
}

interface ExportQaUiState {
  status: 'running' | 'passed' | 'issues' | 'error';
  attempts: number;
  report?: ExportQaReport;
  evidenceUrl?: string;
  message?: string;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ExportDirectoryHandle {
  getFileHandle(name: string, options: { create: true }): Promise<{
    createWritable(): Promise<{ write(data: Blob | string): Promise<void>; close(): Promise<void> }>;
  }>;
}

async function selectExportDirectory(): Promise<ExportDirectoryHandle | null> {
  const picker = (window as Window & {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<ExportDirectoryHandle>;
  }).showDirectoryPicker;
  if (!picker) return null;
  return picker.call(window, { mode: 'readwrite' });
}

async function writeExportFile(directory: ExportDirectoryHandle, name: string, data: Blob | string): Promise<void> {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(data);
  await writable.close();
}

export function ExportDialog({ state, projectName, onClose }: ExportDialogProps) {
  const t = useT();
  const [tab, setTab] = useState<ExportTab>('video');
  const [codec, setCodec] = useState<'h264' | 'vp8'>('h264');
  // Default resolution = closest to the short side of the timeline (1080×1920 → 1080p)
  const defaultRes = useMemo(() => {
    const minSide = Math.min(state.width, state.height);
    if (minSide <= 480) return '480p';
    if (minSide <= 720) return '720p';
    return '1080p';
  }, [state.width, state.height]);
  const [resolution, setResolution] = useState<ExportResolution>(defaultRes);
  // Default frame rate = Timeline fps falls into the gear (if not, it takes 30)
  const [fps, setFps] = useState<number>(FPS_OPTIONS.some((candidate) => candidate === state.fps) ? state.fps : 30);
  const [subtitleFormat, setSubtitleFormat] = useState<'srt' | 'txt'>('srt');
  const captionTracks = useMemo(() => captionTrackEntries(state).filter((entry) => entry.captions), [state]);
  const [subtitleTrack, setSubtitleTrack] = useState(captionTracks[0]?.id ?? '');
  const subtitleCaptions = captionTracks.find((entry) => entry.id === subtitleTrack)?.captions ?? null;
  const [nleFormat, setNleFormat] = useState<'fcp_xml' | 'fcp_xml_resolve'>('fcp_xml');
  const [includeMg, setIncludeMg] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [clock, setClock] = useState(Date.now());

  const [renderEngine, setRenderEngine] = useState<RenderEngine>('idle');
  const browserAbortRef = useRef<AbortController | null>(null);
  const [autoQaEnabled, setAutoQaEnabled] = useState(() => loadExportAutoQaPreference().enabled);
  const [qa, setQa] = useState<ExportQaUiState | null>(null);

  useEffect(() => {
    if (!captionTracks.some((entry) => entry.id === subtitleTrack)) setSubtitleTrack(captionTracks[0]?.id ?? '');
  }, [captionTracks, subtitleTrack]);


  useEffect(() => {
    if (!busy) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  const mgItems = useMemo(() => state.items.filter((it) => it.kind === 'motion-graphic'), [state.items]);
  const base = sanitizeFileName(projectName, 'export');
  const activeTab = TABS.find((entry) => entry.key === tab) ?? TABS[0];
  const outputName = tab === 'video'
    ? `${base}.${codec === 'vp8' ? 'webm' : 'mp4'}`
    : tab === 'audio' ? `${base}.mp3`
      : tab === 'subtitles' ? `${base}.${subtitleFormat}`
        : tab === 'xml' ? `${base}-${nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'premiere'}.fcpxml`
          : t('{n} a transparent MOV File', { n: mgItems.length });
  const actionLabel: Record<ExportTab, string> = {
    video: 'Export to movie',
    audio: 'Extract audio tracks',
    mg: 'Export dynamic layers',
    subtitles: 'Download subtitles',
    xml: 'Generate editing project',
  };


  const toggleAutoQa = (enabled: boolean) => {
    setAutoQaEnabled(enabled);
    saveExportAutoQaPreference({ enabled });
    if (!enabled) setQa(null);
  };

  const verifyCompletedExport = async (completed: NonNullable<ExportJobSnapshot['result']>) => {
    if (!completed.path) return;
    setBusy(t('Checking export quality...'));
    setQa({ status: 'running', attempts: 0 });
    setProgress((current) => current ? {
      ...current,
      phase: 'verifying',
      percent: 99,
      detail: t('Check the picture, sound, editing point and subtitle safe area, and automatically recheck at most if it fails. 3 wheel'),
    } : current);
    const baseline = exportQaExpectations(state);
    const expected = {
      ...baseline,
      durationSeconds: completed.durationSeconds ?? baseline.durationSeconds,
      width: completed.width ?? baseline.width,
      height: completed.height ?? baseline.height,
      fps: completed.fps ?? fps,
    };
    const sourceStart = completed.sourceStartSeconds ?? 0;
    const cutTimesSeconds = timelineCutTimesSeconds(state, 24)
      .map((seconds) => Number((seconds - sourceStart).toFixed(4)))
      .filter((seconds) => seconds > 0 && seconds < expected.durationSeconds)
      .slice(0, 8);
    try {
      const result = await runExportQa({
        src: completed.path,
        ...expected,
        cutTimesSeconds,
        maxEvidenceCuts: 8,
      });
      const report = mergeExportQaIssues(result.response.report, captionLayoutQaIssues(state));
      const mediaType = result.response.evidence?.mediaType ?? 'image/jpeg';
      const base64 = result.response.evidence?.base64;
      setQa({
        status: report.issues.length ? 'issues' : 'passed',
        attempts: result.attempts,
        report,
        ...(base64 ? { evidenceUrl: `data:${mediaType};base64,${base64}` } : {}),
      });
    } catch (reason) {
      setQa({
        status: 'error',
        attempts: 0,
        message: reason instanceof Error ? reason.message : String(reason),
      });
    }
  };

  /** Server compatibility path: async render jobs report real Remotion progress before download. */

  const exportMedia = async (format: 'video' | 'audio') => {
    if (format === 'video') setRenderEngine('server');
    const useCodec = format === 'audio' ? 'mp3' : codec;
    const body: Record<string, unknown> = { state, format, codec: useCodec, name: base };
    if (format === 'video') {
      body.resolution = resolution;
      if (fps !== state.fps) body.fps = fps;
    }
    const submission = await fetch('/export/job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const submitted = (await submission.json().catch(() => null)) as { renderId?: string; error?: string } | null;
    if (!submission.ok || !submitted?.renderId) {
      throw new Error(submitted?.error ?? t('Export failed ({status})', { status: submission.status }));
    }

    let completed: ExportJobSnapshot['result'];
    while (!completed) {
      const response = await fetch(`/export/job/${encodeURIComponent(submitted.renderId)}`);
      const snapshot = (await response.json().catch(() => null)) as ExportJobSnapshot | { error?: string } | null;
      if (!response.ok || !snapshot || !('status' in snapshot)) {
        const message = snapshot && 'error' in snapshot ? snapshot.error : undefined;
        throw new Error(message ?? t('Unable to read export progress ({status})', { status: response.status }));
      }
      if (snapshot.status === 'failed') throw new Error(snapshot.error ?? t('Export failed'));
      if (snapshot.status === 'succeeded') {
        if (!snapshot.result?.path) throw new Error(t('Export completed, but no files available for download'));
        setProgress((current) => current ? {
          ...current,
          phase: 'finalizing',
          percent: 99,
          processedFrames: snapshot.processedFrames,
          totalFrames: snapshot.totalFrames,
        } : current);
        completed = snapshot.result;
        break;
      }
      const phase: ExportPhase = snapshot.phase === 'queued'
        ? 'queued'
        : snapshot.phase === 'finalizing' ? 'finalizing'
          : snapshot.phase === 'rendering' ? 'rendering' : 'preparing';
      setProgress((current) => current ? {
        ...current,
        phase,
        percent: Math.min(99, Math.max(current.percent, Math.round(snapshot.progress))),
        processedFrames: snapshot.processedFrames,
        totalFrames: snapshot.totalFrames,
      } : current);
      await wait(300);
    }

    if (format === 'video' && autoQaEnabled) await verifyCompletedExport(completed);

    setBusy(t('Downloading…'));
    setProgress((current) => current ? { ...current, phase: 'downloading', percent: 99 } : current);
    const file = await fetch(completed.path!);
    if (!file.ok) throw new Error(t('Failed to download export file ({status})', { status: file.status }));
    const blob = await file.blob();
    const ext = format === 'audio' ? 'mp3' : useCodec === 'vp8' ? 'webm' : 'mp4';
    const filename = completed.name ?? `${base}.${ext}`;
    downloadBlob(blob, filename);
    // UI exports are one-shot downloads. Remove the temporary async-job file so it
    // does not appear as a new library asset or accumulate in the media directory.
    void fetch(`/export/job/${encodeURIComponent(submitted.renderId)}`, { method: 'DELETE' }).catch(() => {});
    setProgress((current) => current ? { ...current, outputSize: completed.sizeBytes ?? blob.size } : current);
    void recordExport({ name: filename, format, codec: useCodec, sizeBytes: completed.sizeBytes ?? blob.size, createdAt: Date.now() });
  };

  /** Videos are passed first in the browser WebCodecs Rendering, unsupported timeline seamless fallback to the server. */
  const exportVideo = async () => {
    // Auto QA verifies the server-side artifact before it is downloaded, so it
    // must use the compatibility path instead of the in-memory browser blob.
    if (autoQaEnabled) {
      setRenderEngine('server');
      await exportMedia('video');
      return;
    }

    const controller = new AbortController();
    browserAbortRef.current = controller;
    setRenderEngine('checking');
    try {
      const result = await exportVideoWithFallback({
        browser: async () => {
          const attempt = await renderTimelineInBrowser({
            state,
            codec,
            resolution,
            fps,
            signal: controller.signal,
            onProgress: (snapshot) => {
              setRenderEngine('browser');
              const percent = Math.min(98, Math.max(1, Math.round(snapshot.progress * 98)));
              setBusy(t('Browser rendering...'));
              setProgress((current) => current ? {
                ...current,
                phase: 'rendering',
                percent: Math.max(current.percent, percent),
                processedFrames: snapshot.encodedFrames,
                totalFrames: Math.max(1, timelineDuration(state)),
                detail: t('WebCodecs browser acceleration'),
              } : current);
            },
          });
          if (attempt.status === 'rendered') setRenderEngine('browser');
          return attempt;
        },
        server: () => exportMedia('video'),
        onFallback: (reason) => {
          setRenderEngine('server');
          setBusy(t('Toggle compatible rendering…'));
          setProgress((current) => current ? {
            ...current,
            phase: 'preparing',
            percent: 0,
            processedFrames: undefined,
            totalFrames: undefined,
            detail: t('Browser guide is not available:{reason}, compatible rendering has been switched', { reason }),
          } : current);
        },
      });
      if (result.engine === 'server') return;

      setBusy(t('Downloading…'));
      setProgress((current) => current ? {
        ...current,
        phase: 'downloading',
        percent: 99,
        outputSize: result.attempt.blob.size,
      } : current);
      const filename = `${base}.${codec === 'vp8' ? 'webm' : 'mp4'}`;
      downloadBlob(result.attempt.blob, filename);
      void recordExport({
        name: filename,
        format: 'video',
        codec,
        sizeBytes: result.attempt.blob.size,
        createdAt: Date.now(),
      });
    } finally {
      if (browserAbortRef.current === controller) browserAbortRef.current = null;
    }
  };

  /** MGanimation:Render one by one ProRes 4444 alpha .mov(Reuse single fragment export pipeline)。 */
  const exportMgBatch = async () => {
    for (let i = 0; i < mgItems.length; i++) {
      setBusy(t('rendering MG {i}/{n} · {name}', { i: i + 1, n: mgItems.length, name: mgItems[i].name }));
      setProgress((current) => current ? {
        ...current,
        phase: 'rendering',
        percent: Math.round((i / mgItems.length) * 95),
        detail: t('Rendering the {i}/{n} dynamic layers', { i: i + 1, n: mgItems.length }),
      } : current);
      await exportClipMov(state, mgItems[i]);
    }
    void recordExport({ name: `${mgItems.length} a MG · ProRes 4444`, format: 'video', codec: 'prores', createdAt: Date.now() });
  };

  const exportSubtitles = () => {
    if (!subtitleCaptions) throw new Error(t('Please turn on subtitles first'));
    const text = subtitleFormat === 'srt'
      ? captionsToSrt(subtitleCaptions, state.items, state.fps)
      : captionsToTxt(subtitleCaptions, state.items, state.fps);
    if (!text) throw new Error(t('The current subtitle track has no exportable content'));
    downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${base}.${subtitleFormat}`);
    void recordExport({ name: `${base}.${subtitleFormat}`, format: 'subtitles', createdAt: Date.now() });
  };

  const exportXml = async () => {
    // Pick the destination while the Export click still has user activation.
    // Exact filenames matter because the FCPXML references the rendered MOVs
    // relatively. Browsers without the directory API retain the download fallback.
    const directory = includeMg ? await selectExportDirectory() : null;
    const successfulRenderKeys: string[] = [];
    const failedRenderNames: string[] = [];
    if (includeMg) {
      const uniqueMgItems = Array.from(new Map(
        mgItems.map((item) => [motionGraphicRenderKey(item), item] as const),
      ).entries());
      for (let i = 0; i < uniqueMgItems.length; i++) {
        const [renderKey, item] = uniqueMgItems[i];
        setBusy(t('rendering MG {i}/{n} · {name}', { i: i + 1, n: uniqueMgItems.length, name: item.name }));
        setProgress((current) => current ? {
          ...current,
          phase: 'rendering',
          percent: Math.round((i / uniqueMgItems.length) * 90),
          detail: t('Rendering the {i}/{n} dynamic layers', { i: i + 1, n: uniqueMgItems.length }),
        } : current);
        try {
          const rendered = await renderClipMovBlob(state, item, { filename: motionGraphicRenderFilename(renderKey) });
          if (directory) await writeExportFile(directory, rendered.filename, rendered.blob);
          else downloadBlob(rendered.blob, rendered.filename);
          successfulRenderKeys.push(renderKey);
        } catch {
          failedRenderNames.push(item.name);
        }
      }
    }
    const xml = timelineToFcpxml(state, {
      title: projectName,
      nleFormat,
      motionGraphicRenderKeys: successfulRenderKeys,
    });
    const suffix = nleFormat === 'fcp_xml_resolve' ? 'resolve' : 'premiere';
    const xmlFilename = `${base}-${suffix}.fcpxml`;
    const xmlBlob = new Blob([xml], { type: 'application/xml;charset=utf-8' });
    if (directory) await writeExportFile(directory, xmlFilename, xmlBlob);
    else downloadBlob(xmlBlob, xmlFilename);
    void recordExport({ name: `${base}-${suffix}.fcpxml`, format: 'xml', createdAt: Date.now() });
    if (failedRenderNames.length) {
      setProgress((current) => current ? {
        ...current,
        detail: t('{n} Dynamic layer rendering failed,XML Placeholder reserved', { n: failedRenderNames.length }),
      } : current);
    }
  };

  const run = async () => {
    if (busy) return;
    if (progress?.phase === 'completed') { onClose(); return; }
    setError(null);
    setQa(null);
    const startedAt = Date.now();
    setClock(startedAt);
    setProgress({ phase: 'preparing', percent: 0, startedAt });
    setBusy(t('Prepare to export…'));
    try {
      if (tab === 'video') await exportVideo();
      else if (tab === 'audio') await exportMedia('audio');
      else if (tab === 'mg') await exportMgBatch();
      else if (tab === 'subtitles') exportSubtitles();
      else await exportXml();
      const finishedAt = Date.now();
      setClock(finishedAt);
      setProgress((current) => current ? { ...current, phase: 'completed', percent: 100, finishedAt } : current);
    } catch (err) {
      if (isAbortError(err)) {
        setProgress((current) => current ? {
          ...current,
          phase: 'cancelled',
          finishedAt: Date.now(),
          detail: t('Browser rendering canceled'),
        } : current);
        return;
      }
      const message = err instanceof Error ? err.message : t('Export failed');
      setError(message);
      setProgress((current) => current ? { ...current, phase: 'failed', finishedAt: Date.now() } : current);
    } finally {
      setBusy(null);
    }
  };

  const disabled = !!busy
    || (tab === 'subtitles' && !subtitleCaptions)
    || (tab === 'mg' && mgItems.length === 0);

  const phaseLabel = progress ? ({
    queued: t('Waiting for rendering'),
    preparing: t('Prepare materials'),
    rendering: t('Rendering'),
    finalizing: t('Packaging'),
    verifying: t('Under quality inspection'),
    downloading: t('Downloading'),
    completed: t('Export completed'),
    failed: t('Export failed'),
    cancelled: t('Canceled'),
  } as Record<ExportPhase, string>)[progress.phase] : '';
  const elapsedMs = progress ? (progress.finishedAt ?? clock) - progress.startedAt : 0;
  const etaMs = progress && progress.phase === 'rendering' && progress.percent >= 3 && progress.percent < 99
    ? elapsedMs * (100 - progress.percent) / progress.percent
    : null;

  return (
    <div className="cc-export-overlay" onClick={busy ? undefined : onClose}>
      <div
        className="cc-export-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cc-export-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cc-export-header">
          <div>
            <h2 id="cc-export-title">{t('Export')}</h2>
            <p>{base} · {state.width}×{state.height} · {state.fps} fps</p>
          </div>
          <button type="button" className="cc-export-close" onClick={onClose} disabled={!!busy} title={t('close')}>
            <Icon name="x" size={16} />
          </button>
        </header>

        <div className="cc-export-layout">
          <aside className="cc-export-sidebar">
            <span className="cc-export-sidebar-label">{t('Output type')}</span>
            <div className="cc-export-tabs" role="tablist" aria-label={t('Output type')}>
              {TABS.map((entry) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === entry.key}
                  aria-controls={`cc-export-content-${entry.key}`}
                  id={`cc-export-tab-${entry.key}`}
                  key={entry.key}
                  className={`cc-export-tab${tab === entry.key ? ' active' : ''}`}
                  onClick={() => { setTab(entry.key); setError(null); setProgress(null); setQa(null); }}
                  disabled={!!busy}
                >
                  <span className="cc-export-tab-icon"><Icon name={entry.icon} size={15} /></span>
                  <span>
                    <strong>{t(entry.label)}</strong>
                    <small>{entry.summary}</small>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <main className="cc-export-main">
            <div className="cc-export-main-header">
              <div>
                <h3>{t(activeTab.label)}</h3>
                <p>{activeTab.summary}</p>
              </div>
              <span className="cc-export-local-badge"><i />{tab !== 'video' ? t('native rendering')
                : renderEngine === 'server' ? t('Compatible rendering')
                  : renderEngine === 'browser' ? t('browser acceleration')
                    : renderEngine === 'checking' ? t('Detect browser') : t('Browser first')}</span>
            </div>

            <div
              className="cc-export-content"
              role="tabpanel"
              id={`cc-export-content-${tab}`}
              aria-labelledby={`cc-export-tab-${tab}`}
            >
              {tab === 'video' && (
                <>
                  <Row label={t('encoding')}>
                    <select className="cc-export-select" value={codec} onChange={(event) => setCodec(event.target.value as 'h264' | 'vp8')}>
                      <option value="h264">MP4 (H.264)</option>
                      <option value="vp8">WebM (VP8)</option>
                    </select>
                  </Row>
                  <Row label={t('resolution')}>
                    <Segmented options={RESOLUTIONS.map((value) => ({ value, label: value }))} value={resolution} onChange={setResolution} />
                  </Row>
                  <Row label={t('Frame rate')}>
                    <Segmented options={FPS_OPTIONS.map((value) => ({ value, label: `${value} fps` }))} value={fps} onChange={setFps} />
                  </Row>
                  <label className="cc-export-toggle cc-export-qa-toggle">
                    <span>
                      <strong>{t('Automatic quality check after export')}</strong>
                      <small>{t('Check the picture, sound, editing point and subtitle safe area; automatic recheck at most if temporary failure occurs 3 wheel.')}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={autoQaEnabled}
                      onChange={(event) => toggleAutoQa(event.target.checked)}
                      disabled={!!busy}
                    />
                  </label>
                  {qa && <ExportQaCard qa={qa} />}
                </>
              )}

              {tab === 'audio' && (
                <InfoCard icon="music" title={t('MP3 audio track')} text={t('Extracts the complete mix from the timeline, the video footage is not written to the file.')} />
              )}

              {tab === 'mg' && (
                <InfoCard
                  icon="sparkles"
                  title={mgItems.length ? t('{n} dynamic layers', { n: mgItems.length }) : t('No dynamic layers available for export')}
                  text={mgItems.length
                    ? t('Generate with transparent channel one by one ProRes 4444 MOV, to facilitate reuse in other projects.')
                    : t('Add it to the timeline first MG Animation, and then generate transparent material from here.')}
                />
              )}

              {tab === 'subtitles' && (
                <>
                  {!captionTracks.length && (
                    <InfoCard icon="captions" title={t('The subtitle track has not been enabled yet')} text={t('After turning on subtitles and confirming the content, you can download the subtitle draft.')} />
                  )}
                  <Row label={t('subtitle track')}>
                    <select className="cc-export-select" value={subtitleTrack} disabled={!captionTracks.length} onChange={(event) => setSubtitleTrack(event.target.value)}>
                      {!captionTracks.length && <option value="">—</option>}
                      {captionTracks.map((entry) => <option key={entry.id} value={entry.id}>{trackAlias(state, entry.id)}</option>)}
                    </select>
                  </Row>
                  <Row label={t('Format')}>
                    <Segmented
                      options={[{ value: 'srt', label: 'SubRip (.srt)' }, { value: 'txt', label: 'plain text (.txt)' }] as const}
                      value={subtitleFormat} onChange={setSubtitleFormat}
                    />
                  </Row>
                </>
              )}

              {tab === 'xml' && (
                <>
                  <InfoCard icon="clipboard" title={t('Projects that can be edited')} text={t('Generate files with track and material references FCPXML, give it to Premiere Pro Or Leonardo da Vinci continues to make.')} />
                  <Row label={t('target software')}>
                    <Segmented
                      options={[{ value: 'fcp_xml', label: 'Premiere Pro' }, { value: 'fcp_xml_resolve', label: 'da vinci' }] as const}
                      value={nleFormat} onChange={setNleFormat}
                    />
                  </Row>
                  <label className="cc-export-toggle">
                    <span>
                      <strong>{t('Pack dynamic layers simultaneously')}</strong>
                      <small>{t('Additional generation with transparency channel ProRes 4444 MOV。')}</small>
                    </span>
                    <input type="checkbox" checked={includeMg} onChange={(event) => setIncludeMg(event.target.checked)}
                      disabled={mgItems.length === 0} />
                  </label>
                  <p className="cc-export-footnote">{t('After importing, point your editing software to the folder containing the original footage to relink the offline clips.')}</p>
                </>
              )}

              {error && <p className="cc-export-error">{error}</p>}
            </div>

            <footer className={`cc-export-footer${progress ? ' has-progress' : ''}`}>
              {progress && (
                <div
                  className={`cc-export-progress ${progress.phase}`}
                  role="progressbar"
                  aria-label={phaseLabel}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress.percent}
                >
                  <div className="cc-export-progress-head">
                    <strong>{phaseLabel}</strong>
                    <span>{progress.percent}%</span>
                  </div>
                  <div className="cc-export-progress-track" aria-hidden="true">
                    <i style={{ width: `${progress.percent}%` }} />
                  </div>
                  <div className="cc-export-progress-meta">
                    {progress.processedFrames !== undefined && progress.totalFrames !== undefined && (
                      <span>{t('Rendered {done}/{total} frame', { done: progress.processedFrames, total: progress.totalFrames })}</span>
                    )}
                    {progress.detail && <span>{progress.detail}</span>}
                    <span>{t('Used {time}', { time: formatDuration(elapsedMs) })}</span>
                    {etaMs !== null && etaMs < 24 * 60 * 60_000 && (
                      <span>{t('Estimated remaining {time}', { time: formatDuration(etaMs) })}</span>
                    )}
                    {progress.outputSize !== undefined && <span>{t('file size {size}', { size: formatBytes(progress.outputSize) })}</span>}
                  </div>
                </div>
              )}
              <div className="cc-export-output">
                <span>{progress?.phase === 'completed' ? t('Generated') : t('About to generate')}</span>
                <strong title={outputName}>{outputName}</strong>
              </div>
              {busy && (renderEngine === 'checking' || renderEngine === 'browser') && (
                <button
                  type="button"
                  className="cc-export-cancel"
                  onClick={() => browserAbortRef.current?.abort()}
                >
                  {t('Cancel')}
                </button>
              )}
              <button
                type="button"
                className="cc-export-cta"
                onClick={() => void run()}
                disabled={disabled}
              >
                {!busy && <Icon name={progress?.phase === 'completed' ? 'check' : 'download'} size={17} />}
                {busy ? `${progress?.percent ?? 0}%` : progress?.phase === 'completed' ? t('Complete')
                  : progress?.phase === 'failed' ? t('Try again') : t(actionLabel[tab])}
              </button>
            </footer>
          </main>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="cc-export-field">
      <span>{label}</span>
      {children}
    </div>
  );
}

function InfoCard({ icon, title, text }: { icon: IconName; title: string; text: string }) {
  return (
    <div className="cc-export-info">
      <span><Icon name={icon} size={19} /></span>
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </div>
  );
}

const QA_ISSUE_LABELS: Record<string, string> = {
  missing_video: 'The finished film is missing a video track',
  duration_mismatch: 'The duration of the film is inconsistent with the timeline',
  resolution_mismatch: 'The final film resolution is inconsistent with the export settings',
  fps_mismatch: 'The frame rate of the film is inconsistent with the export settings',
  missing_audio: 'The finished film lacks the proper audio track',
  black_frames: 'Abnormal black frame detected',
  frozen_frames: 'Long still frame detected',
  long_silence: 'Long silence detected',
  audio_peak: 'Audio peaks are close to clipping',
  caption_safe_area_horizontal: 'Subtitles exceed the horizontal safe zone',
  caption_safe_area_vertical: 'Subtitles exceed the vertical safe zone',
};

function qaIssueLabel(issue: ExportQaIssue, translate: ReturnType<typeof useT>): string {
  const label = translate(QA_ISSUE_LABELS[issue.code] ?? issue.message);
  if (issue.startSeconds === undefined) return label;
  const end = issue.endSeconds ?? issue.startSeconds;
  return `${label} · ${issue.startSeconds.toFixed(2)}–${end.toFixed(2)}s`;
}

function ExportQaCard({ qa }: { qa: ExportQaUiState }) {
  const t = useT();
  if (qa.status === 'running') {
    return <div className="cc-export-qa-card running"><strong>{t('Automatically checking the finished film...')}</strong></div>;
  }
  if (qa.status === 'error') {
    return (
      <div className="cc-export-qa-card error">
        <strong>{t('Automated quality check not completed')}</strong>
        <p>{t('The finished film will still download normally; you can re-export it later for review.')} {qa.message}</p>
      </div>
    );
  }
  const report = qa.report!;
  return (
    <div className={`cc-export-qa-card ${qa.status}`}>
      <div className="cc-export-qa-summary">
        <strong>{qa.status === 'passed' ? t('Automatic quality check passed') : t('Automatic quality checks identify issues')}</strong>
        <span>{t('{errors} errors · {warnings} warning', {
          errors: report.summary.errors,
          warnings: report.summary.warnings,
        })}</span>
      </div>
      {qa.attempts > 1 && <p>{t('No. {n} Round inspection completed', { n: qa.attempts })}</p>}
      {report.issues.length > 0 && (
        <ul>
          {report.issues.map((issue, index) => (
            <li key={`${issue.code}-${issue.startSeconds ?? index}`} className={issue.severity}>
              {qaIssueLabel(issue, t)}
            </li>
          ))}
        </ul>
      )}
      {qa.evidenceUrl && (
        <details>
          <summary>{t('Check out the before and after pictures of the editing point')}</summary>
          <img src={qa.evidenceUrl} alt={t('Picture comparison before and after the editing point')} />
        </details>
      )}
    </div>
  );
}

function Segmented<T extends string | number>({ options, value, onChange }: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  const t = useT();
  return (
    <div className="cc-export-segmented">
      {options.map((option) => (
        <button type="button" key={String(option.value)} className={`cc-export-seg${option.value === value ? ' active' : ''}`} onClick={() => onChange(option.value)}>
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}
