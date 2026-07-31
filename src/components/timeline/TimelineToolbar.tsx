// Toolbar at the top of the timeline (translated verbatim from Timeline.tsx): Editing mode cluster / Drop track mode / Narration recording /
// Play + time code / zoom cluster / aspect ratio / caption display / full screen. The timecode span is drawn by the playhead painter
// timecodeRef direct writing (rAF frame), here only the initial value is rendered.
import { useRef, useState, type MouseEvent, type RefObject } from 'react';
import { theme } from '../../theme';
import { Icon, type IconName } from '../icons';
import { ASPECT_PRESETS, captionTrackEntries, type TimelineState } from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import { useT } from '../../i18n/locale';
import { useFocusReturn } from '../../hooks/useFocusReturn';
import { invokeAction } from '../../shortcuts/actionRegistry';
import { MIN_TIME_ZOOM, fmt, type EditMode } from './timelineUtil';
import { TimelineSpeedControl } from './TimelineSpeedControl';
import { SceneDetectionDialog } from '../../scene-detection/SceneDetectionDialog';
import { MotionTrackingDialog } from '../../tracking/MotionTrackingDialog';
import { TrackCreateControl } from './TrackCreateControl';

// Group spacing between toolbar clusters uses gaps without a visible divider.
function ToolSep() {
  return <span className="cc-timeline-tool-separator" aria-hidden="true" />;
}

// One icon toolbar button: monochrome line glyphs, active = accent.
// Prompt to use cc-tip real-time tooltip (native title has ~1s inherent delay); tipRight = right-aligned near the right edge
function TB({ icon, title, onClick, active, disabled, tipRight }: {
  icon: IconName; title: string; onClick?: () => void; active?: boolean; disabled?: boolean; tipRight?: boolean;
}) {
  return (
    <button className={`cc-tip${tipRight ? ' cc-tip-r' : ''}`} data-tip={title} aria-label={title} onClick={onClick} disabled={disabled}
      style={{ width: 24, height: 24, background: 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: 0, borderRadius: 4, display: 'grid', placeItems: 'center', lineHeight: 0, color: disabled ? theme.textDim : active ? theme.accent : theme.textMuted, opacity: disabled ? 0.4 : 1 }}
      onMouseEnter={(e) => { if (!disabled && !active) e.currentTarget.style.background = theme.panelAlt; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <Icon name={icon} size={16} />
    </button>
  );
}
function closeTimelineMenu(details: HTMLDetailsElement | null, restoreFocus = false) {
  if (!details) return;
  details.open = false;
  if (restoreFocus) queueMicrotask(() => details.querySelector<HTMLElement>('summary')?.focus());
}

function runMenuAction(
  event: MouseEvent<HTMLButtonElement>,
  action: () => void,
  restoreFocus = true,
) {
  action();
  closeTimelineMenu(event.currentTarget.closest('details'), restoreFocus);
}

function TimelineMoreControl(props: {
  placeMode: 'insert' | 'overwrite';
  sceneEnabled: boolean;
  trackingEnabled: boolean;
  onScene: (restoreFocus: () => void) => void;
  onTracking: (restoreFocus: () => void) => void;
  onPlaceMode: (mode: 'insert' | 'overwrite') => void;
}) {
  const t = useT();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const restoreFocus = () => detailsRef.current?.querySelector<HTMLElement>('summary')?.focus();
  return (
    <details
      ref={detailsRef}
      onToggle={(event) => {
        const details = event.currentTarget;
        if (details.open) requestAnimationFrame(() => details.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
      }}
      className="cc-track-create cc-timeline-more"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !event.currentTarget.open) return;
        event.preventDefault();
        event.stopPropagation();
        closeTimelineMenu(detailsRef.current, true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeTimelineMenu(event.currentTarget);
      }}
    >
      <summary aria-label={t('更多操作')} title={t('更多操作')}><Icon name="more" size={16} /></summary>
      <div className="cc-track-create-menu cc-timeline-more-menu">
        <button disabled={!props.sceneEnabled} onClick={(event) => runMenuAction(event, () => props.onScene(restoreFocus), false)}>
          <Icon name="sparkles" size={15} />{t('场景检测')}
        </button>
        <button disabled={!props.trackingEnabled} onClick={(event) => runMenuAction(event, () => props.onTracking(restoreFocus), false)}>
          <Icon name="tracking" size={15} />{t('运动跟踪')}
        </button>
        <div className="cc-track-create-separator" />
        <button className={props.placeMode === 'insert' ? 'selected' : ''} onClick={(event) => runMenuAction(event, () => props.onPlaceMode('insert'))}>
          <Icon name="insert" size={15} />{t('插入落轨')}
        </button>
        <button className={props.placeMode === 'overwrite' ? 'selected' : ''} onClick={(event) => runMenuAction(event, () => props.onPlaceMode('overwrite'))}>
          <Icon name="film" size={15} />{t('覆盖落轨')}
        </button>
      </div>
    </details>
  );
}

interface TimelineToolbarProps {
  state: TimelineState;
  commands: EditorCommands;
  editMode: EditMode;
  placeMode: 'insert' | 'overwrite';
  setPlaceMode: (m: 'insert' | 'overwrite') => void;
  snapping: boolean;
  recorder: { recording: boolean; error: string | null; toggle: () => void };
  canRecord: boolean;
  playing: boolean;
  /** painted imperatively by the playhead painter */
  timecodeRef: RefObject<HTMLSpanElement | null>;
  playheadFrame: number;
  total: number;
  captionsVisible: boolean;
  zoom: number;
  setZoom: (z: number) => void;
}

export function TimelineToolbar({
  state, commands, editMode, placeMode, setPlaceMode, snapping,
  recorder, canRecord, playing, timecodeRef, playheadFrame, total, captionsVisible,
  zoom, setZoom,
}: TimelineToolbarProps) {
  const t = useT();
  const speedItem = state.items.find((item) => (
    item.id === state.selectedId && (item.kind === 'video' || item.kind === 'audio' || item.kind === 'sequence')
  )) ?? null;
  const sceneItem = state.items.find((item) => (
    item.id === state.selectedId && (item.kind === 'video' || item.kind === 'gif')
  )) ?? null;
  const trackingItem = state.items.find((item) => (
    item.id === state.selectedId
    && item.kind === 'video'
    && /^\/media\/uploads\//.test(item.src ?? '')
  )) ?? null;
  const [sceneDetectionOpen, setSceneDetectionOpen] = useState(false);
  const [motionTrackingOpen, setMotionTrackingOpen] = useState(false);
  const modalFocus = useFocusReturn();
  const captionTracks = captionTrackEntries(state).filter((entry) => entry.captions);
  return (
    <>
      <div className="cc-timeline-toolbar">
      <div className="cc-timeline-tool-group">
        <TrackCreateControl commands={commands} />
        <ToolSep />
        <TB icon="cursor" title={t('选择模式 (V)：拖动移动 / 裁剪首尾')} active={editMode === 'selection'} onClick={() => invokeAction('interaction-mode-selection', undefined, 'toolbar')} />
        <TB icon="trim" title={t('修剪模式 (N)：裁剪片段边缘，后续片段自动跟随合缝（波纹）')} active={editMode === 'trim'} onClick={() => invokeAction('interaction-mode-trim', undefined, 'toolbar')} />
        <TB
          icon="swap"
          title={t('滑移模式 (U)：保持时间线位置和时长，仅拖动源素材区间')}
          active={editMode === 'slip'}
          onClick={() => invokeAction('interaction-mode-slip', undefined, 'toolbar')}
        />
        <TB
          icon="rateStretch"
          title={editMode === 'rate-stretch'
            ? t('退出比率拉伸，返回选择模式')
            : t('比率拉伸：拖动片段首尾，保持源区间并改变播放速度')}
          active={editMode === 'rate-stretch'}
          onClick={() => invokeAction(
            editMode === 'rate-stretch' ? 'interaction-mode-selection' : 'interaction-mode-rate-stretch',
            undefined,
            'toolbar',
          )}
        />
        <TB icon="blade" title={t('刀片模式 (B)：点击片段在该处切分')} active={editMode === 'blade'} onClick={() => invokeAction('interaction-mode-blade', undefined, 'toolbar')} />
        <TB icon="pencil" title={t('钢笔模式 (P)：在选中片段上点击绘制关键帧（视觉片段=透明度，音频片段=音量；纵向=值，拖点改帧/值，右键删点）')} active={editMode === 'pen'} onClick={() => invokeAction('interaction-mode-pen', undefined, 'toolbar')} />
        <TB icon="scissors" title={t('在播放头切分选中片段 (C)')} onClick={() => invokeAction('split', undefined, 'toolbar')} />
        <TB icon="magnet" title={snapping ? t('磁性吸附：开 (S)') : t('磁性吸附：关 (S)')} active={snapping} onClick={() => invokeAction('snapping', undefined, 'toolbar')} />
        <ToolSep />
        <TimelineMoreControl
          placeMode={placeMode}
          sceneEnabled={!!sceneItem}
          trackingEnabled={!!trackingItem}
          onScene={(restoreFocus) => { modalFocus.remember(restoreFocus); setSceneDetectionOpen(true); }}
          onTracking={(restoreFocus) => { modalFocus.remember(restoreFocus); setMotionTrackingOpen(true); }}
          onPlaceMode={setPlaceMode}
        />
        <ToolSep />
        <span className="cc-mic-group">
          <TB icon="mic" active={recorder.recording}
            title={recorder.recording ? t('● 录音中，点击停止') : recorder.error ? t('录音失败：{error}', { error: recorder.error }) : t('录制旁白（麦克风 → 音频轨）')}
            disabled={!canRecord} onClick={recorder.toggle} />
          <Icon name="chevronDown" size={13} />
        </span>
        {recorder.recording && <span title={t('录音中')} style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent, animation: 'cc-rec-pulse 1.2s ease-out infinite', flexShrink: 0 }} />}
        <TimelineSpeedControl
          item={speedItem}
          onChange={(rate) => { if (speedItem) commands.setItemSpeed(speedItem.id, rate); }}
        />
      </div>
      <div className="cc-timeline-transport">
      <TB
        icon={playing ? 'pause' : 'play'}
        title={playing ? t('暂停 (空格)') : t('播放 (空格)')}
        active={playing}
        onClick={() => invokeAction('play-pause', undefined, 'toolbar')}
      />
      <span ref={timecodeRef} className="cc-timeline-timecode">{fmt(playheadFrame, state.fps)} / {fmt(total, state.fps)}</span>
      </div>
      <div className="cc-timeline-view-controls">
      <TB icon="zoomOut" title={t('缩小时间轴 (⌘−)')} tipRight onClick={() => invokeAction('zoom-out', undefined, 'toolbar')} />
      <input type="range" min={MIN_TIME_ZOOM} max={6} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
        title={t('缩放时间轴')} className="cc-timeline-zoom" />
      <TB icon="zoomIn" title={t('放大时间轴 (⌘＋)')} tipRight onClick={() => invokeAction('zoom-in', undefined, 'toolbar')} />
      <TB icon="fit" title={t('适配视图 (⇧Z)')} tipRight onClick={() => invokeAction('zoom-fit', undefined, 'toolbar')} />
      <label className="cc-aspect-select cc-tip cc-tip-r" data-tip={t('画幅比例')}>
        <Icon name="aspect" size={16} />
        <select aria-label={t('画幅比例')} value={ASPECT_PRESETS.find((preset) => preset.width === state.width && preset.height === state.height)?.label ?? ''}
          onChange={(event) => {
            if (event.target.value === '__contain__' || event.target.value === '__cover__') {
              commands.setAspect(state.width, state.height, event.target.value === '__cover__' ? 'cover' : 'contain');
              return;
            }
            const preset = ASPECT_PRESETS.find((entry) => entry.label === event.target.value);
            if (preset) commands.setAspect(preset.width, preset.height, state.fit);
          }}>
          <optgroup label={t('画幅比例')}>{ASPECT_PRESETS.map((preset) => <option key={preset.label} value={preset.label}>{preset.label}</option>)}</optgroup>
          <optgroup label={t('内容适配')}><option value="__contain__">{t('留边')}</option><option value="__cover__">{t('裁切')}</option></optgroup>
        </select>
      </label>
      <button className={`cc-caption-toggle cc-tip cc-tip-r${captionsVisible ? ' active' : ''}`} data-tip={captionTracks.length ? t('字幕显示') : t('字幕显示（当前还没有字幕，先转写或让 Agent 生成）')} aria-label={t('字幕显示')} disabled={!captionTracks.length} onClick={() => commands.batch(captionTracks.map((entry) => ({ type: 'updateCaptions', track: entry.id, patch: { enabled: !captionsVisible } })), 'Toggle captions')}><Icon name="captions" size={17} /><span>{captionsVisible ? t('开启') : t('未开启')}</span><Icon name="chevronDown" size={13} /></button>
      <TB icon="fullscreen" title={t('全屏预览')} tipRight onClick={() => invokeAction('fullscreen', undefined, 'toolbar')} />
      </div>
      </div>
      {sceneDetectionOpen && sceneItem && (
        <SceneDetectionDialog
          state={state}
          commands={commands}
          item={sceneItem}
          onClose={() => { setSceneDetectionOpen(false); modalFocus.restore(); }}
        />
      )}
      {motionTrackingOpen && trackingItem && (
        <MotionTrackingDialog
          state={state}
          commands={commands}
          item={trackingItem}
          onClose={() => { setMotionTrackingOpen(false); modalFocus.restore(); }}
        />
      )}
    </>
  );
}
