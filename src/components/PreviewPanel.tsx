import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Player, type CallbackListener, type PlayerRef } from '@remotion/player';
import { theme, themeAlpha } from '../theme';
import { TimelineComposition } from '../editor/TimelineComposition';
import { captionTrackEntries, timelineDuration, type TimelineState, type TrackId } from '../editor/types';
import { canvasRegionRef, emitSelectionRef, regionFromDrag, useSelectionRefMode } from '../agent/selection-refs';
import { CaptionPreviewEditor } from '../captions/CaptionPreviewEditor';
import type { CaptionsData } from '../captions/types';
import {
  onCaptionStylePointerDrop,
  type CaptionStyleDragPayload,
} from '../captions/captionStyleDrag';
import { appendDroppedManualCaption } from '../captions/manualCaptions';
import { Icon } from './icons';
import { useT } from '../i18n/locale';

const SHARED_AUDIO_TAGS = 32;

interface PreviewPanelProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  onImport: (file: File) => Promise<void>;
  /** Canvas subtitle direct editing(Check box+floating toolbar). Not passed on(Such as proposal preview status)then read-only. */
  onUpdateCaptions?: (patch: Partial<CaptionsData>, track?: TrackId) => void;
  onSeedChat?: (text: string) => void;
}

export const PreviewPanel = memo(function PreviewPanel({ state, playerRef, onImport, onUpdateCaptions, onSeedChat }: PreviewPanelProps) {
  const t = useT();
  const duration = timelineDuration(state);
  const inputRef = useRef<HTMLInputElement>(null);
  const videoBoxRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [showSafe, setShowSafe] = useState(false);
  const [autoEditCaption, setAutoEditCaption] = useState<{ trackId: TrackId; laneId: string } | null>(null);
  // Expose Player during full screen preview (` shortcut key/timeline toolbar button to make Player full screen)
  // Comes with a control bar; the editing state still uses the timeline transport, and does not display dual sets of controls.
  // Must listen to Remotion's own fullscreenchange: it walks the webkit legacy API in Chrome,
  // The document standard event is not guaranteed to follow, the SDK emitter is the real source.
  const [fullscreen, setFullscreen] = useState(false);
  const hasItems = state.items.length > 0;
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onChange: CallbackListener<'fullscreenchange'> = (e) => setFullscreen(e.detail.isFullscreen);
    player.addEventListener('fullscreenchange', onChange);
    return () => player.removeEventListener('fullscreenchange', onChange);
  }, [playerRef, hasItems]);
  // Selection mode (canvas-region-marked): drag a marquee → region reference
  const pickMode = useSelectionRefMode();
  const importFiles = async (files: FileList | File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    try { for (const file of Array.from(files)) await onImport(file); }
    finally { setBusy(false); }
  };
  const dropCaptionStyle = (payload: CaptionStyleDragPayload | null, clientX: number, clientY: number): boolean => {
    const box = videoBoxRef.current;
    const entry = captionTrackEntries(state).find(({ id }) => id === payload?.trackId);
    if (!payload || !box || !entry?.captions || !onUpdateCaptions) return false;
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    const startMs = ((playerRef.current?.getCurrentFrame() ?? 0) / state.fps) * 1000;
    const dropped = appendDroppedManualCaption(entry.captions, state.items, payload.template, t('Double click to edit subtitles'), startMs, {
      anchor: 'middle-center', offsetXRatio: x - 0.5, offsetYRatio: y - 0.5,
    });
    if (!dropped) return false;
    playerRef.current?.pause();
    onUpdateCaptions(dropped.patch, payload.trackId);
    setAutoEditCaption({ trackId: payload.trackId, laneId: dropped.laneId });
    return true;
  };
  useEffect(() => onCaptionStylePointerDrop(({ payload, clientX, clientY }) => {
    dropCaptionStyle(payload, clientX, clientY);
  }));
  return (
    <section style={{ display: 'flex', flex: 1, flexDirection: 'column', background: theme.panel, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <div style={{ height: 30, padding: '0 12px', display: 'flex', alignItems: 'center', borderBottom: `0.5px solid ${theme.border}`, flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: theme.text }}>{t('Preview')}</span>
        {pickMode && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 10, fontSize: 11, color: theme.accent }}>
            <Icon name="cursor" size={11} />
            {t('Selection mode: drag the selection frame on the screen as a reference')}
          </span>
        )}
        {state.items.length > 0 && (
          <button type="button" onClick={() => setShowSafe((v) => !v)}
            title={t('Switch title/Action safe zone reference frame (vertical screen composition assistance)')}
            style={{
              marginLeft: 'auto', fontSize: 11, lineHeight: 1, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
              border: `0.5px solid ${theme.border}`, background: showSafe ? theme.panelAlt : 'transparent',
              color: showSafe ? theme.text : theme.textDim,
            }}>
            {t('safe box')}
          </button>
        )}
      </div>
      <div className="cc-preview-stage"
        // Suppress the browser's native <video> context menu (download / picture-in-picture
        // / loop) because the preview is a canvas, not an exposed HTML5 video element.
        onContextMenu={(event) => event.preventDefault()}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }}
        onDrop={(event) => { event.preventDefault(); void importFiles(event.dataTransfer.files); }}>
        {state.items.length === 0 ? (
          <>
            <input ref={inputRef} type="file" accept="video/*,image/*,audio/*" multiple hidden onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ''; }} />
            <button className="cc-preview-empty" disabled={busy} onClick={() => inputRef.current?.click()}>
              <Icon name="upload" size={24} />
              <span>{busy ? t('Importing media...') : t('Drag media here')}</span>
            </button>
          </>
        ) : (
          // Wrapper carries the sizing so the safe-zone overlay lines up exactly
          // on the video rect (Player fills the wrapper).
          <div ref={videoBoxRef} style={{
            position: 'relative', width: 'auto', height: '100%',
            maxWidth: '100%', maxHeight: '100%',
            aspectRatio: `${state.width} / ${state.height}`,
          }}>
            <Player
              ref={playerRef}
              component={TimelineComposition}
              inputProps={{ state }}
              durationInFrames={duration}
              fps={state.fps}
              compositionWidth={state.width}
              compositionHeight={state.height}
              numberOfSharedAudioTags={SHARED_AUDIO_TAGS}
              // Full screen black: Webkit legacy full screen div does not automatically blacken the background, and the page checkerboard will be revealed on both sides.
              style={{ width: '100%', height: '100%', backgroundColor: fullscreen ? '#000' : undefined }}
              controls={fullscreen}
              // Playback runs only through the timeline transport
              // (play/pause button + Space shortcut), not the player itself. clickToPlay
              // off = clicking the frame doesn't toggle; spaceKeyToPlayOrPause off = the app
              // shortcut is the single Space handler (the Player's own handler would
              // double-toggle it to a no-op).
              clickToPlay={fullscreen}
              spaceKeyToPlayOrPause={false}
              loop
            />
            {showSafe && <SafeZoneOverlay />}
            {pickMode && <RegionPickOverlay state={state} playerRef={playerRef} />}
            {!pickMode && !fullscreen && onUpdateCaptions && captionTrackEntries(state).map(({ id, captions }) => captions?.enabled ? (
              <CaptionPreviewEditor
                key={id}
                state={state}
                captions={captions}
                playerRef={playerRef}
                onUpdateCaptions={(patch) => onUpdateCaptions(patch, id)}
                onSeedChat={onSeedChat}
                autoEditLaneId={autoEditCaption?.trackId === id ? autoEditCaption.laneId : undefined}
                onAutoEditHandled={() => setAutoEditCaption(null)}
              />
            ) : null)}
          </div>
        )}
      </div>
    </section>
  );
});

// Selection-mode marquee over the video rect: drag a rectangle → canvas-region
// reference in COMPOSITION coordinates, with the visual clips it covers at the
// current frame (emits openchatcut:canvas-region-marked).
function RegionPickOverlay({ state, playerRef }: { state: TimelineState; playerRef: RefObject<PlayerRef | null> }) {
  const t = useT();
  const boxRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pos = (event: React.PointerEvent) => {
    const rect = boxRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(event.clientX - rect.left, 0), rect.width),
      y: Math.min(Math.max(event.clientY - rect.top, 0), rect.height),
    };
  };
  return (
    <div
      ref={boxRef}
      title={t('Drag and drop to select the screen area as a reference')}
      onPointerDown={(event) => {
        if (event.button !== 0) return; // left button only
        event.currentTarget.setPointerCapture(event.pointerId);
        const p = pos(event);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(event) => {
        if (!drag) return;
        const p = pos(event);
        setDrag((d) => (d ? { ...d, x1: p.x, y1: p.y } : d));
      }}
      onPointerUp={() => {
        if (!drag || !boxRef.current) return;
        const rect = boxRef.current.getBoundingClientRect();
        const region = regionFromDrag(
          { x: drag.x0, y: drag.y0 }, { x: drag.x1, y: drag.y1 },
          rect.width, rect.height, state.width, state.height,
        );
        if (region) {
          emitSelectionRef(canvasRegionRef(region, Math.round(playerRef.current?.getCurrentFrame() ?? 0), state));
        }
        setDrag(null);
      }}
      style={{ position: 'absolute', inset: 0, zIndex: 5, cursor: 'crosshair', touchAction: 'none' }}
    >
      {drag && (
        <div style={{
          position: 'absolute',
          left: Math.min(drag.x0, drag.x1),
          top: Math.min(drag.y0, drag.y1),
          width: Math.abs(drag.x1 - drag.x0),
          height: Math.abs(drag.y1 - drag.y0),
          border: `0.5px solid ${theme.accent}`,
          background: themeAlpha.accent(0.14), // theme.accent @ 14%
          pointerEvents: 'none',
        }} />
      )}
    </div>
  );
}

// Broadcast-style safe areas over the video rect: action-safe (~5% inset) +
// title-safe (~10% inset) + center guides. A pure composition aid for framing
// vertical/short-form cuts; overlay only, never burned into the export.
function SafeZoneOverlay() {
  const frame = (inset: string, opacity: number): CSSProperties => ({
    position: 'absolute', inset, border: `0.5px dashed rgba(255,255,255,${opacity})`, borderRadius: 2,
  });
  const line: CSSProperties = { position: 'absolute', background: 'rgba(255,255,255,0.18)' };
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      <div style={frame('5%', 0.55)} />
      <div style={frame('10%', 0.35)} />
      <div style={{ ...line, left: '50%', top: '46%', width: 1, height: '8%' }} />
      <div style={{ ...line, top: '50%', left: '46%', height: 1, width: '8%' }} />
    </div>
  );
}
