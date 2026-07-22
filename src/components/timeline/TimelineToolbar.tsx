// 时间线顶部工具栏(逐字搬自 Timeline.tsx):编辑模式簇 / 落轨模式 / 旁白录音 /
// 播放+时间码 / 缩放簇 / 画幅比例 / 字幕显示 / 全屏。时间码 span 由播放头绘制器经
// timecodeRef 直写(rAF 合帧),这里只渲初值。
import { useState, type RefObject } from 'react';
import { theme } from '../../theme';
import { Icon, type IconName } from '../icons';
import { ASPECT_PRESETS, captionTrackEntries, type TimelineState } from '../../editor/types';
import type { EditorCommands } from '../../editor/store';
import { useT } from '../../i18n/locale';
import { invokeAction } from '../../shortcuts/actionRegistry';
import { MIN_TIME_ZOOM, fmt, type EditMode } from './timelineUtil';
import { TimelineSpeedControl } from './TimelineSpeedControl';
import { SceneDetectionDialog } from '../../scene-detection/SceneDetectionDialog';
import { MotionTrackingDialog } from '../../tracking/MotionTrackingDialog';
import { TrackCreateControl } from './TrackCreateControl';

// Group spacing between toolbar clusters uses gaps without a visible divider.
function ToolSep() {
  return <span style={{ width: 0, margin: '0 6px', flexShrink: 0 }} />;
}

// One icon toolbar button: monochrome line glyphs, active = accent.
// 提示走 cc-tip 即时 tooltip(原生 title 有 ~1s 固有延迟);tipRight = 近右缘右对齐
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
    item.id === state.selectedId && (item.kind === 'video' || item.kind === 'audio')
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
  const captionTracks = captionTrackEntries(state).filter((entry) => entry.captions);
  return (
    <>
      <div className="cc-timeline-toolbar">
      <div className="cc-timeline-tool-group">
        <TrackCreateControl commands={commands} />
        <ToolSep />
        <TB icon="cursor" title={t('选择模式 (V)：拖动移动 / 裁剪首尾')} active={editMode === 'selection'} onClick={() => invokeAction('interaction-mode-selection', undefined, 'toolbar')} />
        <TB icon="trim" title={t('修剪模式 (N)：裁剪片段边缘，后续片段自动跟随合缝（波纹）')} active={editMode === 'trim'} onClick={() => invokeAction('interaction-mode-trim', undefined, 'toolbar')} />
        <TB icon="rateStretch" title={t('比率拉伸：拖动片段首尾，保持源区间并改变播放速度')} active={editMode === 'rate-stretch'} onClick={() => invokeAction('interaction-mode-rate-stretch', undefined, 'toolbar')} />
        <TB icon="blade" title={t('刀片模式 (B)：点击片段在该处切分')} active={editMode === 'blade'} onClick={() => invokeAction('interaction-mode-blade', undefined, 'toolbar')} />
        <TB icon="pencil" title={t('钢笔模式 (P)：在选中片段上点击绘制透明度关键帧（纵向=不透明度，拖点改帧/值，右键删点）')} active={editMode === 'pen'} onClick={() => invokeAction('interaction-mode-pen', undefined, 'toolbar')} />
        <TB icon="scissors" title={t('在播放头切分选中片段 (C)')} onClick={() => invokeAction('split', undefined, 'toolbar')} />
        <TB
          icon="sparkles"
          title={sceneItem
            ? t('检测选中片段的场景切点')
            : t('选择一个视频片段后进行场景检测')}
          disabled={!sceneItem}
          onClick={() => setSceneDetectionOpen(true)}
        />
        <TB
          icon="tracking"
          title={trackingItem
            ? t('跟踪选中视频中的目标（实验功能）')
            : t('选择一个本机视频片段后进行运动跟踪')}
          disabled={!trackingItem}
          onClick={() => setMotionTrackingOpen(true)}
        />
        <TB icon="magnet" title={snapping ? t('磁性吸附：开 (S)') : t('磁性吸附：关 (S)')} active={snapping} onClick={() => invokeAction('snapping', undefined, 'toolbar')} />
        <ToolSep />
        <TB
          icon="insert"
          title={t('插入落轨：库素材/模板拖入时把后续片段后推（波纹插入）')}
          active={placeMode === 'insert'}
          onClick={() => setPlaceMode('insert')}
        />
        <TB
          icon="film"
          title={t('覆盖落轨：库素材/模板按帧位叠放，不推后续片段（默认）')}
          active={placeMode === 'overwrite'}
          onClick={() => setPlaceMode('overwrite')}
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
      <span style={{ flex: 1 }} />
      <TB
        icon={playing ? 'pause' : 'play'}
        title={playing ? t('暂停 (空格)') : t('播放 (空格)')}
        active={playing}
        onClick={() => invokeAction('play-pause', undefined, 'toolbar')}
      />
      <span ref={timecodeRef} className="cc-timeline-timecode">{fmt(playheadFrame, state.fps)} / {fmt(total, state.fps)}</span>
      <span style={{ flex: 1 }} />
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
      {sceneDetectionOpen && sceneItem && (
        <SceneDetectionDialog
          state={state}
          commands={commands}
          item={sceneItem}
          onClose={() => setSceneDetectionOpen(false)}
        />
      )}
      {motionTrackingOpen && trackingItem && (
        <MotionTrackingDialog
          state={state}
          commands={commands}
          item={trackingItem}
          onClose={() => setMotionTrackingOpen(false)}
        />
      )}
    </>
  );
}
