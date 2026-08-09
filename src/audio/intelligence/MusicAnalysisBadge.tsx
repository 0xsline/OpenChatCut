import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/icons';
import type { MediaAsset } from '../../editor/types';
import { tData, useT } from '../../i18n/locale';
import { enqueueMusicAnalysis, refreshMusicAnalysis } from './jobs';
import {
  getAutoMusicAnalysisEnabled,
  setAutoMusicAnalysisEnabled,
  subscribeAutoMusicAnalysis,
} from './preferences';
import type { MusicAnalysis, MusicSectionRole, MusicTag, MusicTagKind } from './types';
import { requestMusicAnalysisPackRefresh, type MusicAnalysisCardState } from './useMusicAnalysisCards';
import './music-analysis.css';

const TAG_KINDS = ['genre', 'mood', 'instrument', 'usage'] as const satisfies readonly MusicTagKind[];
const TAG_LABELS: Record<MusicTagKind, string> = {
  genre: '流派',
  mood: '情绪',
  instrument: '乐器',
  usage: '用途',
};
const SECTION_LABELS: Record<MusicSectionRole, string> = {
  'intro-like': '前奏',
  build: '推进',
  peak: '高潮',
  break: '间奏',
  steady: '平稳',
  'outro-like': '尾奏',
};
type Translate = (key: string, params?: Record<string, string | number>) => string;

interface MusicAnalysisBadgeProps {
  asset: MediaAsset;
  state: MusicAnalysisCardState;
}

interface PopoverPosition {
  top: number;
  left: number;
  visibility: CSSProperties['visibility'];
}

function bestTag(analysis: MusicAnalysis, kind?: MusicTagKind): MusicTag | undefined {
  let best: MusicTag | undefined;
  for (const tag of analysis.tags) {
    if (kind && tag.kind !== kind) continue;
    if (!best || tag.score > best.score) best = tag;
  }
  return best;
}

function tagText(label: string, t: Translate): string {
  if (label === 'unknown') return t('未知');
  return tData(label);
}

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function timeLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function badgeText(state: MusicAnalysisCardState, t: Translate): string {
  if (state.state === 'checking') return t('检查模型');
  if (state.state === 'unavailable') return t('模型未安装');
  if (state.state === 'idle') return t('分析音乐');
  if (state.state === 'queued') return t('排队中');
  if (state.state === 'running') return `${Math.round(state.progress * 100)}%`;
  if (state.state === 'error') return t('分析失败');
  const tag = bestTag(state.analysis);
  return `${Math.round(state.analysis.bpm)} BPM${tag ? ` · ${tagText(tag.label, t)}` : ''}`;
}

function phaseLabel(phase: 'decode' | 'rhythm' | 'semantic', t: Translate): string {
  if (phase === 'decode') return t('解码音频');
  if (phase === 'rhythm') return t('分析节拍');
  return t('理解音乐内容');
}

function usePopoverPosition(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
): PopoverPosition {
  const [position, setPosition] = useState<PopoverPosition>({ top: 8, left: 8, visibility: 'hidden' });
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const trigger = triggerRef.current;
      const panel = panelRef.current;
      if (!trigger || !panel) return;
      const anchor = trigger.getBoundingClientRect();
      const box = panel.getBoundingClientRect();
      const left = Math.min(window.innerWidth - box.width - 8, Math.max(8, anchor.right - box.width));
      const below = anchor.bottom + box.height + 6 <= window.innerHeight;
      const top = below ? anchor.bottom + 4 : Math.max(8, anchor.top - box.height - 4);
      setPosition({ left, top, visibility: 'visible' });
    };
    update();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (panelRef.current) observer?.observe(panelRef.current);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [open, panelRef, triggerRef]);
  return position;
}

function usePopoverDismiss(
  open: boolean,
  triggerRef: RefObject<HTMLButtonElement | null>,
  panelRef: RefObject<HTMLDivElement | null>,
  close: (restoreFocus?: boolean) => void,
): void {
  useEffect(() => {
    if (!open) return;
    const outside = (target: Node) => !triggerRef.current?.contains(target) && !panelRef.current?.contains(target);
    const onPointer = (event: PointerEvent) => { if (outside(event.target as Node)) close(); };
    const onFocus = (event: FocusEvent) => { if (outside(event.target as Node)) close(); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close(true);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('focusin', onFocus);
    window.addEventListener('keydown', onKey);
    panelRef.current?.querySelector<HTMLButtonElement>('.cc-music-analysis-close')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('focusin', onFocus);
      window.removeEventListener('keydown', onKey);
    };
  }, [close, open, panelRef, triggerRef]);
}

function stopCardInteraction(event: ReactMouseEvent<HTMLElement>): void {
  event.stopPropagation();
}

export function MusicAnalysisBadge({ asset, state }: MusicAnalysisBadgeProps) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) queueMicrotask(() => triggerRef.current?.focus());
  }, []);
  const position = usePopoverPosition(open, triggerRef, panelRef);
  usePopoverDismiss(open, triggerRef, panelRef, close);
  const text = badgeText(state, t);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        draggable={false}
        data-music-analysis-control
        data-state={state.state}
        className="cc-music-analysis-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('音乐分析：{name}，{status}', { name: asset.name, status: text })}
        title={text}
        onPointerDown={stopCardInteraction}
        onClick={(event) => {
          stopCardInteraction(event);
          requestMusicAnalysisPackRefresh();
          setOpen((value) => !value);
        }}
        onDoubleClick={stopCardInteraction}
        onContextMenu={(event) => { event.preventDefault(); stopCardInteraction(event); }}
        onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
      >
        <span className="cc-music-analysis-dot" aria-hidden="true" />
        <span aria-live="polite">{text}</span>
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <MusicAnalysisPopover asset={asset} state={state} panelRef={panelRef} position={position} onClose={() => close(true)} />,
        document.body,
      )}
    </>
  );
}

interface MusicAnalysisPopoverProps {
  asset: MediaAsset;
  state: MusicAnalysisCardState;
  panelRef: RefObject<HTMLDivElement | null>;
  position: PopoverPosition;
  onClose: () => void;
}

function MusicAnalysisPopover({ asset, state, panelRef, position, onClose }: MusicAnalysisPopoverProps) {
  const t = useT();
  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('{name} 的音乐分析', { name: asset.name })}
      className="cc-music-analysis-popover"
      style={position}
      onDragStart={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      data-music-analysis-control
      onClick={stopCardInteraction}
      onPointerDown={stopCardInteraction}
      onDoubleClick={stopCardInteraction}
      onContextMenu={stopCardInteraction}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <header className="cc-music-analysis-head">
        <div className="cc-music-analysis-title"><strong>{t('音乐分析')}</strong><span title={asset.name}>{asset.name}</span></div>
        <button type="button" className="cc-music-analysis-close" aria-label={t('关闭')} onClick={onClose}><Icon name="x" size={15} /></button>
      </header>
      <AnalysisContent state={state} />
      {state.state === 'ready' && state.modelPacksAvailable === false && (
        <p className="cc-music-analysis-state">{t('已显示缓存结果；重新分析需要先安装模型包。')}</p>
      )}
      <AnalysisAction asset={asset} state={state} />
    </div>
  );
}

function AnalysisAction({ asset, state }: { asset: MediaAsset; state: MusicAnalysisCardState }) {
  const t = useT();
  const busy = state.state === 'queued' || state.state === 'running' || state.state === 'checking';
  const canAnalyze = state.modelPacksAvailable === true && !busy;
  const label = state.state === 'error'
    ? t('重试分析')
    : state.state === 'ready'
      ? t('重新分析')
      : t('分析音乐');
  const run = () => {
    if (state.state === 'error' || state.state === 'ready') void refreshMusicAnalysis(asset);
    else void enqueueMusicAnalysis(asset);
  };
  return <div className="cc-music-analysis-actions"><button type="button" className="cc-music-analysis-action" disabled={!canAnalyze} onClick={run}>{label}</button></div>;
}

function AnalysisContent({ state }: { state: MusicAnalysisCardState }) {
  const t = useT();
  if (state.state === 'ready') return <ReadyAnalysis analysis={state.analysis} />;
  if (state.state === 'running') return <p className="cc-music-analysis-state">{phaseLabel(state.phase, t)} · {Math.round(state.progress * 100)}%<progress className="cc-music-analysis-progress" max={1} value={state.progress} /></p>;
  if (state.state === 'queued') return <p className="cc-music-analysis-state">{t('已加入本地分析队列。')}</p>;
  if (state.state === 'error') return <p className="cc-music-analysis-state error">{t('分析失败：{message}', { message: state.message })}</p>;
  if (state.state === 'unavailable') return <p className="cc-music-analysis-state">{t('尚未安装所需模型包。请在本地 AI 设置中分别下载节拍与音乐语义模型；这里不会自动下载。')}</p>;
  if (state.state === 'checking') return <p className="cc-music-analysis-state">{t('正在检查本地模型…')}</p>;
  return <p className="cc-music-analysis-state">{t('在本机分析节拍、结构和音乐语义。音频不会上传。')}</p>;
}

function ReadyAnalysis({ analysis }: { analysis: MusicAnalysis }) {
  const t = useT();
  return (
    <>
      <div className="cc-music-analysis-metrics">
        <Metric label={t('速度')} value={`${Math.round(analysis.bpm)} BPM`} />
        <Metric label={t('拍号')} value={`${analysis.meter}/4`} />
        <Metric label={t('置信度')} value={percent(analysis.beatConfidence)} />
      </div>
      <h4 className="cc-music-analysis-section-title">{t('音乐标签')}</h4>
      <dl className="cc-music-analysis-tags">
        {TAG_KINDS.map((kind) => {
          const tag = bestTag(analysis, kind);
          return <div key={kind}><dt>{t(TAG_LABELS[kind])}</dt><dd title={tag ? `${tagText(tag.label, t)} · ${percent(tag.score)}` : undefined}>{tag ? tagText(tag.label, t) : '—'}</dd></div>;
        })}
      </dl>
      <h4 className="cc-music-analysis-section-title">{t('段落')}</h4>
      {analysis.sections.length > 0
        ? <ol className="cc-music-analysis-sections">{analysis.sections.map((section, index) => <li key={`${section.fromMs}:${index}`}><time>{timeLabel(section.fromMs)}–{timeLabel(section.toMs)}</time><b>{t(SECTION_LABELS[section.role])}</b><span>{percent(section.energy)}</span></li>)}</ol>
        : <p className="cc-music-analysis-state">{t('未识别到明确段落')}</p>}
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="cc-music-analysis-metric"><span>{label}</span><strong>{value}</strong></div>;
}

export function MusicAutoAnalysisPreference() {
  const t = useT();
  const enabled = useSyncExternalStore(
    subscribeAutoMusicAnalysis,
    getAutoMusicAnalysisEnabled,
    getAutoMusicAnalysisEnabled,
  );
  return (
    <div className="cc-music-analysis-pref" data-music-analysis-control>
      <button
        type="button"
        role="switch"
        className="cc-music-analysis-pref-toggle"
        aria-checked={enabled}
        onClick={() => setAutoMusicAnalysisEnabled(!enabled)}
      >
        <span>{t('自动分析新导入的音视频')}</span>
        <span className="cc-music-analysis-switch" aria-hidden="true" />
      </button>
      <p className="cc-music-analysis-pref-note">{t('需要先在本地 AI 设置中单独下载模型包；开启此选项不会自动下载。')}</p>
    </div>
  );
}
