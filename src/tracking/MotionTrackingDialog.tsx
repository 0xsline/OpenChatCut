import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { EditorCommands } from '../editor/store';
import type { TimelineItem, TimelineState } from '../editor/types';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { analyzeMotion } from './analyzeMotion';
import { buildTrackingKeyframeActions, trackingTargets, type TrackingApplyMode } from './keyframeActions';
import { TrackingError, type TrackingProgress, type TrackingRegion, type TrackingResult } from './types';
import { TrackingRegionPicker } from './TrackingRegionPicker';
import './motion-tracking.css';

interface MotionTrackingDialogProps { state: TimelineState; commands: EditorCommands; item: TimelineItem; onClose: () => void }
interface AnalysisState {
  progress: TrackingProgress | null; result: TrackingResult | null; error: string | null; running: boolean;
  run: () => Promise<void>; cancel: () => void; reset: () => void; setError: (message: string | null) => void;
}

const STABILIZE = '__stabilize__';
const INITIAL_REGION: TrackingRegion = { x: 0.35, y: 0.3, width: 0.3, height: 0.4 };

function errorLabel(error: unknown, t: ReturnType<typeof useT>): string {
  if (!(error instanceof TrackingError)) return error instanceof Error ? error.message : String(error);
  return ({
    'load-failed': t('无法读取所选视频'),
    'seek-failed': t('读取视频帧超时'),
    'flat-target': t('框选区域缺少纹理，请选择边缘和细节更明显的目标'),
    'invalid-region': t('框选区域太小，请重新框选'),
  })[error.code];
}

function useTrackingAnalysis(state: TimelineState, item: TimelineItem, region: TrackingRegion, minConfidence: number): AnalysisState {
  const t = useT();
  const [progress, setProgress] = useState<TrackingProgress | null>(null);
  const [result, setResult] = useState<TrackingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const run = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true); setResult(null); setError(null);
    setProgress({ processedFrames: 0, totalFrames: 1, confidence: null });
    try {
      setResult(await analyzeMotion({
        src: item.src!, fps: state.fps, srcInFrame: item.srcInFrame ?? 0,
        durationInFrames: item.durationInFrames, playbackRate: item.playbackRate ?? 1,
        region, minConfidence, signal: controller.signal, onProgress: setProgress,
      }));
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError(errorLabel(cause, t));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };
  const reset = () => { setProgress(null); setResult(null); setError(null); };
  return { progress, result, error, running, run, cancel: () => abortRef.current?.abort(), reset, setError };
}

function TrackingHeader({ item, close }: { item: TimelineItem; close: () => void }) {
  const t = useT();
  return <header className="cc-tracking-header">
    <div><h2 id="cc-tracking-title">{t('运动跟踪')} <em>{t('实验功能')}</em></h2><p>{item.name} · {t('本机分析，不上传素材')}</p></div>
    <button type="button" onClick={close} aria-label={t('关闭')}><Icon name="x" size={17} /></button>
  </header>;
}

interface TrackingSettingsProps {
  targets: TimelineItem[]; targetId: string; running: boolean; minConfidence: number; percent: number;
  result: TrackingResult | null; locked: boolean; error: string | null;
  onTarget: (id: string) => void; onConfidence: (value: number) => void;
}

function TrackingSettings(props: TrackingSettingsProps) {
  const t = useT();
  return <aside>
    <label><span>{t('应用方式')}</span><select value={props.targetId} disabled={props.running} onChange={(event) => props.onTarget(event.target.value)}>
      <option value={STABILIZE}>{t('稳定所选视频画面')}</option>
      {props.targets.map((target) => <option key={target.id} value={target.id}>{t('让「{name}」跟随目标', { name: target.name })}</option>)}
    </select></label>
    <label><span>{t('最低置信度')}</span><strong>{props.minConfidence.toFixed(2)}</strong><input type="range" min={0.5} max={0.9} step={0.01} value={props.minConfidence} disabled={props.running} onChange={(event) => props.onConfidence(Number(event.target.value))} /></label>
    <div className="cc-tracking-progress"><div><span>{props.running ? t('正在跟踪画面…') : props.result ? t('跟踪分析完成') : t('等待框选目标')}</span><strong>{props.percent}%</strong></div><i><b style={{ width: `${props.percent}%` }} /></i></div>
    {props.result && <div className={`cc-tracking-result${props.result.stoppedBecauseLost ? ' warning' : ''}`}>
      <strong>{t('{n} 个有效跟踪点', { n: props.result.points.length })}</strong>
      <span>{t('平均置信度 {value}', { value: props.result.averageConfidence.toFixed(2) })}</span>
      {props.result.stoppedBecauseLost && <small>{t('目标连续丢失，已提前停止；低置信度帧不会写入关键帧。')}</small>}
    </div>}
    {props.locked && <p className="cc-tracking-error">{t('目标轨道已锁定')}</p>}
    {props.error && <p className="cc-tracking-error">{props.error}</p>}
    <p className="cc-tracking-note">{t('应用后会替换目标现有的 X/Y 关键帧；可在“变换”中继续手动修正。')}</p>
  </aside>;
}

interface TrackingFooterProps { analysis: AnalysisState; applied: boolean; canApply: boolean; apply: () => void }
function TrackingFooter({ analysis, applied, canApply, apply }: TrackingFooterProps) {
  const t = useT();
  return <footer><span>{applied ? t('已应用；一次撤销可还原全部跟踪关键帧') : ''}</span><div>
    {analysis.running
      ? <button type="button" onClick={analysis.cancel}>{t('取消跟踪')}</button>
      : <button type="button" onClick={() => void analysis.run()}>{analysis.result ? t('重新分析') : t('开始分析')}</button>}
    <button type="button" className="primary" disabled={!canApply || applied} onClick={apply}>{t('应用关键帧')}</button>
  </div></footer>;
}

export function MotionTrackingDialog({ state, commands, item, onClose }: MotionTrackingDialogProps) {
  const t = useT();
  const targets = useMemo(() => trackingTargets(state, item), [state, item]);
  const [targetId, setTargetId] = useState(targets[0]?.id ?? STABILIZE);
  const [region, setRegion] = useState<TrackingRegion>(INITIAL_REGION);
  const [minConfidence, setMinConfidence] = useState(0.68);
  const [applied, setApplied] = useState(false);
  const analysis = useTrackingAnalysis(state, item, region, minConfidence);
  const mode: TrackingApplyMode = targetId === STABILIZE ? 'stabilize' : 'follow';
  const target = mode === 'stabilize' ? item : targets.find((candidate) => candidate.id === targetId) ?? null;
  const locked = !!target && !!state.tracks?.[target.track]?.locked;
  const percent = analysis.progress ? Math.round(analysis.progress.processedFrames * 100 / Math.max(1, analysis.progress.totalFrames)) : 0;
  const close = () => { analysis.cancel(); onClose(); };
  const apply = () => {
    if (!analysis.result || !target || locked) return;
    const actions = buildTrackingKeyframeActions({ state, source: item, target, result: analysis.result, mode });
    if (!actions.length) return analysis.setError(t('有效跟踪点与目标片段没有足够的重叠范围'));
    commands.batch(actions, 'Apply experimental motion tracking');
    setApplied(true);
  };
  const changeRegion = (next: TrackingRegion) => { setRegion(next); analysis.reset(); setApplied(false); };
  const changeTarget = (id: string) => { setTargetId(id); setApplied(false); };
  const changeConfidence = (value: number) => { setMinConfidence(value); analysis.reset(); setApplied(false); };
  return createPortal(<div className="cc-tracking-overlay" role="dialog" aria-modal="true" aria-labelledby="cc-tracking-title" onClick={analysis.running ? undefined : close}>
    <section className="cc-tracking-dialog" onClick={(event) => event.stopPropagation()}>
      <TrackingHeader item={item} close={close} />
      <div className="cc-tracking-body"><main>
        <TrackingRegionPicker item={item} fps={state.fps} region={region} points={analysis.result?.points ?? []} disabled={analysis.running} onChange={changeRegion} />
        <p>{t('在起始画面拖拽框选纹理清晰的目标；分析后轨迹会显示在画面上。')}</p>
      </main><TrackingSettings targets={targets} targetId={targetId} running={analysis.running} minConfidence={minConfidence} percent={percent} result={analysis.result} locked={locked} error={analysis.error} onTarget={changeTarget} onConfidence={changeConfidence} /></div>
      <TrackingFooter analysis={analysis} applied={applied} canApply={!!analysis.result && analysis.result.points.length >= 2 && !!target && !locked} apply={apply} />
    </section>
  </div>, document.body);
}
