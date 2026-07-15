import { memo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { TimelineComposition } from '../editor/TimelineComposition';
import { timelineDuration, type TimelineState } from '../editor/types';
import { Icon } from './icons';

interface PreviewPanelProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  onImport: (file: File) => Promise<void>;
}

export const PreviewPanel = memo(function PreviewPanel({ state, playerRef, onImport }: PreviewPanelProps) {
  const duration = timelineDuration(state);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showSafe, setShowSafe] = useState(false);
  const importFiles = async (files: FileList | File[]) => {
    if (!files.length || busy) return;
    setBusy(true);
    try { for (const file of Array.from(files)) await onImport(file); }
    finally { setBusy(false); }
  };
  return (
    <section style={{ display: 'flex', flex: 1, flexDirection: 'column', background: theme.panel, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <div style={{ height: 30, padding: '0 12px', display: 'flex', alignItems: 'center', borderBottom: `1px solid ${theme.border}`, flexShrink: 0 }}>
        <span style={{ fontSize: 12, color: theme.text }}>预览</span>
        {state.items.length > 0 && (
          <button type="button" onClick={() => setShowSafe((v) => !v)}
            title="切换标题/动作安全区参考框（竖屏成片构图辅助）"
            style={{
              marginLeft: 'auto', fontSize: 11, lineHeight: 1, padding: '3px 8px', borderRadius: 5, cursor: 'pointer',
              border: `1px solid ${theme.border}`, background: showSafe ? theme.panelAlt : 'transparent',
              color: showSafe ? theme.text : theme.textDim,
            }}>
            安全框
          </button>
        )}
      </div>
      <div className="cc-preview-stage"
        // Suppress the browser's native <video> context menu (download / picture-in-picture
        // / loop) — the source viewer is a canvas, not an exposed HTML5 video element.
        onContextMenu={(event) => event.preventDefault()}
        onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void importFiles(event.dataTransfer.files); }}>
        {state.items.length === 0 ? (
          <>
            <input ref={inputRef} type="file" accept="video/*,image/*,audio/*" multiple hidden onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.target.value = ''; }} />
            <button className="cc-preview-empty" disabled={busy} onClick={() => inputRef.current?.click()}>
              <Icon name="upload" size={24} />
              <span>{busy ? '正在导入媒体…' : '拖拽媒体到这里'}</span>
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
              style={{ width: '100%', height: '100%' }}
              controls={false}
              // Source-faithful viewer: playback runs ONLY through the timeline transport
              // (play/pause button + Space shortcut), not the player itself. clickToPlay
              // off = clicking the frame doesn't toggle; spaceKeyToPlayOrPause off = the app
              // shortcut is the single Space handler (the Player's own handler would
              // double-toggle it to a no-op).
              clickToPlay={false}
              spaceKeyToPlayOrPause={false}
              loop
            />
            {showSafe && <SafeZoneOverlay />}
          </div>
        )}
      </div>
    </section>
  );
});

// Broadcast-style safe areas over the video rect: action-safe (~5% inset) +
// title-safe (~10% inset) + center guides. A pure composition aid for framing
// vertical/short-form cuts; overlay only, never burned into the export.
function SafeZoneOverlay() {
  const frame = (inset: string, opacity: number): CSSProperties => ({
    position: 'absolute', inset, border: `1px dashed rgba(255,255,255,${opacity})`, borderRadius: 2,
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
