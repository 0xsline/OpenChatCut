import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditorCommands } from '../editor/store';
import type { TimelineItem, TimelineState } from '../editor/types';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { mapScenesToItem, sceneMarkerActions, sceneSplitActions } from './apply';
import {
  cancelSceneDetectionJob,
  getSceneDetectionJob,
  startSceneDetectionJob,
  type SceneDetectionJobSnapshot,
} from './jobs';
import './scene-detection.css';

interface SceneDetectionDialogProps {
  state: TimelineState;
  commands: EditorCommands;
  item: TimelineItem;
  onClose: () => void;
}

const ACTIVE = new Set(['queued', 'probing', 'detecting', 'finalizing']);

function formatTime(timeMs: number): string {
  const seconds = Math.max(0, timeMs) / 1000;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${(seconds % 60).toFixed(2).padStart(5, '0')}`;
}

export function SceneDetectionDialog({ state, commands, item, onClose }: SceneDetectionDialogProps) {
  const t = useT();
  const [threshold, setThreshold] = useState(0.3);
  const [minSceneSeconds, setMinSceneSeconds] = useState(0.75);
  const [maxScenes, setMaxScenes] = useState(200);
  const [job, setJob] = useState<SceneDetectionJobSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<'markers' | 'split' | null>(null);
  const running = !!job && ACTIVE.has(job.status);
  const locked = !!state.tracks?.[item.track]?.locked;
  const jobId = job?.id;
  const jobStatus = job?.status;

  useEffect(() => {
    if (!jobId || !jobStatus || !ACTIVE.has(jobStatus)) return;
    let disposed = false;
    const timer = window.setInterval(() => {
      void getSceneDetectionJob(jobId).then((next) => {
        if (!disposed) setJob(next);
      }).catch((cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      });
    }, 300);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [jobId, jobStatus]);

  const evidence = useMemo(() => job?.result?.scenes ?? [], [job?.result?.scenes]);
  const mapped = useMemo(
    () => mapScenesToItem(evidence, item, state.fps),
    [evidence, item, state.fps],
  );
  const mappedTimes = useMemo(() => new Set(mapped.map((scene) => scene.timeMs)), [mapped]);

  const start = async () => {
    if (!item.src?.startsWith('/media/uploads/')) {
      setError(t('场景检测只支持已经保存到本机素材库的视频'));
      return;
    }
    setError(null);
    setApplied(null);
    try {
      setJob(await startSceneDetectionJob({
        src: item.src,
        threshold,
        minSceneMs: Math.round(minSceneSeconds * 1000),
        maxScenes,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const cancel = async () => {
    if (!job || !running) return;
    try {
      setJob(await cancelSceneDetectionJob(job.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const close = () => {
    if (job && running) void cancelSceneDetectionJob(job.id).catch(() => undefined);
    onClose();
  };

  const apply = (mode: 'markers' | 'split') => {
    if (locked) {
      setError(t('当前轨道已锁定，无法应用场景检测结果'));
      return;
    }
    if (!mapped.length || applied) return;
    const actions = mode === 'markers'
      ? sceneMarkerActions(item, mapped)
      : sceneSplitActions(item, mapped);
    commands.batch(actions, mode === 'markers' ? 'Add scene markers' : 'Split clip at scene changes');
    setApplied(mode);
  };

  const phase = job ? ({
    queued: t('等待检测'),
    probing: t('分析素材信息'),
    detecting: t('检测场景变化'),
    finalizing: t('整理检测结果'),
    completed: t('检测完成'),
    failed: t('检测失败'),
    cancelled: t('已取消'),
  } as const)[job.status] : t('尚未开始');

  return createPortal(
    <div className="cc-scene-overlay" role="dialog" aria-modal="true" aria-labelledby="cc-scene-title" onClick={running ? undefined : close}>
      <section className="cc-scene-dialog" onClick={(event) => event.stopPropagation()}>
        <header className="cc-scene-header">
          <div>
            <h2 id="cc-scene-title">{t('场景检测')}</h2>
            <p>{item.name} · {t('本机分析，不上传素材')}</p>
          </div>
          <button type="button" className="cc-scene-icon-button" onClick={close} aria-label={t('关闭')}>
            <Icon name="x" size={17} />
          </button>
        </header>

        <div className="cc-scene-body">
          <aside className="cc-scene-options">
            <label>
              <span>{t('检测灵敏度')}</span>
              <strong>{threshold.toFixed(2)}</strong>
              <input type="range" min={0.05} max={0.95} step={0.01} value={threshold} disabled={running}
                onChange={(event) => setThreshold(Number(event.target.value))} />
              <small>{t('数值越低，检测到的切点越多')}</small>
            </label>
            <label>
              <span>{t('最短场景间隔')}</span>
              <strong>{minSceneSeconds.toFixed(2)}s</strong>
              <input type="range" min={0.1} max={10} step={0.05} value={minSceneSeconds} disabled={running}
                onChange={(event) => setMinSceneSeconds(Number(event.target.value))} />
            </label>
            <label>
              <span>{t('最多切点')}</span>
              <input className="cc-scene-number" type="number" min={1} max={500} value={maxScenes} disabled={running}
                onChange={(event) => setMaxScenes(Math.max(1, Math.min(500, Number(event.target.value) || 1)))} />
            </label>

            <div className="cc-scene-progress-card">
              <div><span>{phase}</span><strong>{Math.round((job?.progress ?? 0) * 100)}%</strong></div>
              <div className="cc-scene-progress-track"><i style={{ width: `${Math.round((job?.progress ?? 0) * 100)}%` }} /></div>
              {job?.status === 'detecting' && job.result === null && (
                <small>{t('已分析到 {time}', { time: formatTime(job.processedMs) })}</small>
              )}
            </div>

            {running ? (
              <button type="button" className="cc-scene-button secondary" onClick={() => void cancel()}>{t('取消检测')}</button>
            ) : (
              <button type="button" className="cc-scene-button primary" onClick={() => void start()}>{job ? t('重新检测') : t('开始检测')}</button>
            )}
            {error && <p className="cc-scene-error">{error}</p>}
          </aside>

          <main className="cc-scene-results">
            <div className="cc-scene-results-header">
              <div>
                <h3>{t('切点证据')}</h3>
                <p>{job?.status === 'completed'
                  ? t('检测到 {all} 个切点，当前片段可应用 {mapped} 个', { all: evidence.length, mapped: mapped.length })
                  : t('检测完成后会显示切点前后的画面对比')}</p>
              </div>
              {job?.result && <span>{job.result.sampleFps.toFixed(1)} fps</span>}
            </div>

            <div className="cc-scene-list">
              {job?.status !== 'completed' && (
                <div className="cc-scene-empty"><Icon name="film" size={28} /><span>{running ? t('正在读取画面变化…') : t('调整参数后开始检测')}</span></div>
              )}
              {job?.status === 'completed' && evidence.length === 0 && (
                <div className="cc-scene-empty"><Icon name="check" size={28} /><span>{t('没有发现满足条件的场景切点')}</span></div>
              )}
              {evidence.map((scene, index) => {
                const applicable = mappedTimes.has(scene.timeMs);
                return (
                  <article className={`cc-scene-row${applicable ? '' : ' outside'}`} key={`${scene.timeMs}-${index}`}>
                    <div className="cc-scene-row-meta">
                      <strong>#{index + 1}</strong>
                      <span>{formatTime(scene.timeMs)}</span>
                      <em>{scene.kind === 'cut' ? t('硬切') : t('渐变')}</em>
                      <small>{scene.score.toFixed(3)}</small>
                    </div>
                    <div className="cc-scene-evidence">
                      <figure><img src={scene.beforeThumbnailUrl} alt={t('切点前画面')} loading="lazy" /><figcaption>{t('之前')}</figcaption></figure>
                      <i><Icon name="next" size={16} /></i>
                      <figure><img src={scene.afterThumbnailUrl} alt={t('切点后画面')} loading="lazy" /><figcaption>{t('之后')}</figcaption></figure>
                    </div>
                    {!applicable && <span className="cc-scene-outside">{t('不在当前裁切范围')}</span>}
                  </article>
                );
              })}
            </div>
          </main>
        </div>

        <footer className="cc-scene-footer">
          <span>{applied === 'markers' ? t('已添加场景标记') : applied === 'split' ? t('已按场景切分片段') : locked ? t('轨道已锁定') : ''}</span>
          <div>
            <button type="button" className="cc-scene-button secondary" disabled={!mapped.length || !!applied || locked} onClick={() => apply('markers')}>{t('添加场景标记')}</button>
            <button type="button" className="cc-scene-button primary" disabled={!mapped.length || !!applied || locked} onClick={() => apply('split')}>{t('按场景切分')}</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
