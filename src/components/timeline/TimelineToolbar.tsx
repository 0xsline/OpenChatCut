// Timeline top toolbar (word-for-word copy from Timeline.tsx): Edit mode cluster / Drop track mode / Narration recording /
// Play+timecode/zoom cluster/aspect ratio/subtitle display/full screen. The timecode span is drawn by the playhead painter
// timecodeRef direct writing (rAF frame), here only the initial value is rendered.
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
        <TB icon="cursor" title={t('Select mode (V):Drag to move / Crop the beginning and the end')} active={editMode === 'selection'} onClick={() => invokeAction('interaction-mode-selection', undefined, 'toolbar')} />
        <TB icon="trim" title={t('Trim mode (N): Crop the edge of the fragment, and subsequent fragments will automatically follow the seam (ripple)')} active={editMode === 'trim'} onClick={() => invokeAction('interaction-mode-trim', undefined, 'toolbar')} />
        <TB
          icon="rateStretch"
          title={editMode === 'rate-stretch'
            ? t('Exit ratio stretching and return to selection mode')
            : t('Ratio stretch: drag the beginning and end of the clip to maintain the source range and change the playback speed')}
          active={editMode === 'rate-stretch'}
          onClick={() => invokeAction(
            editMode === 'rate-stretch' ? 'interaction-mode-selection' : 'interaction-mode-rate-stretch',
            undefined,
            'toolbar',
          )}
        />
        <TB icon="blade" title={t('blade mode (B):Click the segment to split it there')} active={editMode === 'blade'} onClick={() => invokeAction('interaction-mode-blade', undefined, 'toolbar')} />
        <TB icon="pencil" title={t('pen mode (P): Click to draw a transparency keyframe on the selected clip (vertical=Opacity, drag to change frame/value, right click and delete)')} active={editMode === 'pen'} onClick={() => invokeAction('interaction-mode-pen', undefined, 'toolbar')} />
        <TB icon="scissors" title={t('Cut the selected clip in the playhead (C)')} onClick={() => invokeAction('split', undefined, 'toolbar')} />
        <TB
          icon="sparkles"
          title={sceneItem
            ? t('Detect scene cut points of selected clips')
            : t('Scene detection after selecting a video clip')}
          disabled={!sceneItem}
          onClick={() => setSceneDetectionOpen(true)}
        />
        <TB
          icon="tracking"
          title={trackingItem
            ? t('Track objects in selected videos (experimental)')
            : t('Motion tracking after selecting a native video clip')}
          disabled={!trackingItem}
          onClick={() => setMotionTrackingOpen(true)}
        />
        <TB icon="magnet" title={snapping ? t('Magnetic adsorption: on (S)') : t('Magnetic adsorption: off (S)')} active={snapping} onClick={() => invokeAction('snapping', undefined, 'toolbar')} />
        <ToolSep />
        <TB
          icon="insert"
          title={t('Inserting Drop Tracks: Library Materials/When the template is dragged in, subsequent segments are pushed back (ripple insertion)')}
          active={placeMode === 'insert'}
          onClick={() => setPlaceMode('insert')}
        />
        <TB
          icon="film"
          title={t('Covering the Fall Track: Library Materials/Templates are stacked frame by frame and subsequent clips are not pushed (default)')}
          active={placeMode === 'overwrite'}
          onClick={() => setPlaceMode('overwrite')}
        />
        <ToolSep />
        <span className="cc-mic-group">
          <TB icon="mic" active={recorder.recording}
            title={recorder.recording ? t('● During recording, click to stop') : recorder.error ? t('Recording failed:{error}', { error: recorder.error }) : t('Record narration (microphone → audio track)')}
            disabled={!canRecord} onClick={recorder.toggle} />
          <Icon name="chevronDown" size={13} />
        </span>
        {recorder.recording && <span title={t('Recording')} style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent, animation: 'cc-rec-pulse 1.2s ease-out infinite', flexShrink: 0 }} />}
        <TimelineSpeedControl
          item={speedItem}
          onChange={(rate) => { if (speedItem) commands.setItemSpeed(speedItem.id, rate); }}
        />
      </div>
      <span style={{ flex: 1 }} />
      <TB
        icon={playing ? 'pause' : 'play'}
        title={playing ? t('pause (space)') : t('play (space)')}
        active={playing}
        onClick={() => invokeAction('play-pause', undefined, 'toolbar')}
      />
      <span ref={timecodeRef} className="cc-timeline-timecode">{fmt(playheadFrame, state.fps)} / {fmt(total, state.fps)}</span>
      <span style={{ flex: 1 }} />
      <TB icon="zoomOut" title={t('Zoom out timeline (⌘−)')} tipRight onClick={() => invokeAction('zoom-out', undefined, 'toolbar')} />
      <input type="range" min={MIN_TIME_ZOOM} max={6} step={0.01} value={zoom} onChange={(e) => setZoom(Number(e.target.value))}
        title={t('Zoom timeline')} className="cc-timeline-zoom" />
      <TB icon="zoomIn" title={t('Zoom into timeline (⌘＋)')} tipRight onClick={() => invokeAction('zoom-in', undefined, 'toolbar')} />
      <TB icon="fit" title={t('Adapt view (⇧Z)')} tipRight onClick={() => invokeAction('zoom-fit', undefined, 'toolbar')} />
      <label className="cc-aspect-select cc-tip cc-tip-r" data-tip={t('aspect ratio')}>
        <Icon name="aspect" size={16} />
        <select aria-label={t('aspect ratio')} value={ASPECT_PRESETS.find((preset) => preset.width === state.width && preset.height === state.height)?.label ?? ''}
          onChange={(event) => {
            if (event.target.value === '__contain__' || event.target.value === '__cover__') {
              commands.setAspect(state.width, state.height, event.target.value === '__cover__' ? 'cover' : 'contain');
              return;
            }
            const preset = ASPECT_PRESETS.find((entry) => entry.label === event.target.value);
            if (preset) commands.setAspect(preset.width, preset.height, state.fit);
          }}>
          <optgroup label={t('aspect ratio')}>{ASPECT_PRESETS.map((preset) => <option key={preset.label} value={preset.label}>{preset.label}</option>)}</optgroup>
          <optgroup label={t('Content adaptation')}><option value="__contain__">{t('Leave a margin')}</option><option value="__cover__">{t('Cut')}</option></optgroup>
        </select>
      </label>
      <button className={`cc-caption-toggle cc-tip cc-tip-r${captionsVisible ? ' active' : ''}`} data-tip={captionTracks.length ? t('Subtitle display') : t('Subtitle display (currently there are no subtitles, please transcribe or let Agent generated)')} aria-label={t('Subtitle display')} disabled={!captionTracks.length} onClick={() => commands.batch(captionTracks.map((entry) => ({ type: 'updateCaptions', track: entry.id, patch: { enabled: !captionsVisible } })), 'Toggle captions')}><Icon name="captions" size={17} /><span>{captionsVisible ? t('turn on') : t('Not turned on')}</span><Icon name="chevronDown" size={13} /></button>
      <TB icon="fullscreen" title={t('Full screen preview')} tipRight onClick={() => invokeAction('fullscreen', undefined, 'toolbar')} />
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
