import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Player, type CallbackListener, type PlayerRef } from '@remotion/player';
import { theme, themeAlpha } from '../theme';
import { TimelineComposition } from '../editor/TimelineComposition';
import { timelineDuration, type TimelineState } from '../editor/types';
import { canvasRegionRef, emitSelectionRef, regionFromDrag, useSelectionRefMode } from '../agent/selection-refs';
import { CaptionPreviewEditor } from '../captions/CaptionPreviewEditor';
import type { CaptionsData } from '../captions/types';
import { Icon } from './icons';
import { useT } from '../i18n/locale';

const SHARED_AUDIO_TAGS = 32;

interface PreviewPanelProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  onImport: (file: File) => Promise<void>;
  /** 画布字幕直编(选中框+浮动工具条)。未传(如提案预览态)则只读。 */
  onUpdateCaptions?: (patch: Partial<CaptionsData>) => void;
  onSeedChat?: (text: string) => void;
}

export const PreviewPanel = memo(function PreviewPanel({ state, playerRef, onImport, onUpdateCaptions, onSeedChat }: PreviewPanelProps) {
  const t = useT();
  const duration = timelineDuration(state);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showSafe, setShowSafe] = useState(false);
  // 全屏预览(` 快捷键/时间线工具栏按钮把 Player 全屏)时露出 Player
  // 自带控制条;编辑态仍走时间线 transport,不显示双套控制。
  // 必须听 Remotion 自己的 fullscreenchange:它在 Chrome 走 webkit 遗留 API,
  // document 标准事件不保证跟着响,SDK emitter 才是真源。
  const [fullscreen, setFullscreen] = useState(false);
  const hasItems = state.items.length > 0;
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onChange: CallbackListener<'fullscreenchange'> = (e) => setFullscreen(e.detail.isFullscreen);
    player.addEventListener('fullscreenchange', onChange);
    return () => player.removeEventListener('fullscreenchange', onChange);
  }, [playerRef, hasItems]);
  // 选择模式 (canvas-region-marked): drag a marquee → region reference
  const pickMode = useSelectionRefMode();
  const importFiles = async (files: FileList | File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    try { for (const file of Array.from(files)) await onImport(file); }
    finally { setBusy(false); }
  };
  return (
    <section style={{ display: 'flex', flex: 1, flexDirection: 'column', background: theme.panel, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <div style={{ height: 30, padding: '0 12px', display: 'flex', alignItems: 'center', borderBottom: `0.5px solid ${theme.border}`, flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: theme.text }}>{t('预览')}</span>
        {pickMode && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 10, fontSize: 11, color: theme.accent }}>
            <Icon name="cursor" size={11} />
            {t('选择模式：在画面上拖框选区作为引用')}
          </span>
        )}
        {state.items.length > 0 && (
          <button type="button" onClick={() => setShowSafe((v) => !v)}
            title={t('切换标题/动作安全区参考框（竖屏成片构图辅助）')}
            style={{
              marginLeft: 'auto', fontSize: 11, lineHeight: 1, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
              border: `0.5px solid ${theme.border}`, background: showSafe ? theme.panelAlt : 'transparent',
              color: showSafe ? theme.text : theme.textDim,
            }}>
            {t('安全框')}
          </button>
        )}
      </div>
      <div className="cc-preview-stage"
        // Suppress the browser's native <video> context menu (download / picture-in-picture
        // / loop) because the preview is a canvas, not an exposed HTML5 video element.
        onContextMenu={(event) => event.preventDefault()}
        onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void importFiles(event.dataTransfer.files); }}>
        {state.items.length === 0 ? (
          <>
            <input ref={inputRef} type="file" accept="video/*,image/*,audio/*" multiple hidden onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ''; }} />
            <button className="cc-preview-empty" disabled={busy} onClick={() => inputRef.current?.click()}>
              <Icon name="upload" size={24} />
              <span>{busy ? t('正在导入媒体…') : t('拖拽媒体到这里')}</span>
            </button>
          </>
        ) : (
          // Wrapper carries the sizing so the safe-zone overlay lines up exactly
          // on the video rect (Player fills the wrapper).
          <div style={{
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
              // 全屏铺黑:webkit 遗留全屏对 div 不自动垫黑底,两侧会透出页面棋盘格
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
            {!pickMode && !fullscreen && onUpdateCaptions && (
              <CaptionPreviewEditor state={state} playerRef={playerRef} onUpdateCaptions={onUpdateCaptions} onSeedChat={onSeedChat} />
            )}
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
      title={t('拖拽框选画面区域作为引用')}
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
