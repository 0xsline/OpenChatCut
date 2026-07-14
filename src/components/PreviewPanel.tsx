import { memo, useRef, useState, type RefObject } from 'react';
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
      </div>
      <div className="cc-preview-stage"
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
          <Player
            ref={playerRef}
            component={TimelineComposition}
            inputProps={{ state }}
            durationInFrames={duration}
            fps={state.fps}
            compositionWidth={state.width}
            compositionHeight={state.height}
            style={{
              // Remotion Player needs a real height to paint; height:auto collapses
              // to 0 in this flex stage → black preview. Fill stage height, cap width.
              width: 'auto',
              height: '100%',
              maxWidth: '100%',
              maxHeight: '100%',
              aspectRatio: `${state.width} / ${state.height}`,
            }}
            controls={false}
            loop
          />
        )}
      </div>
    </section>
  );
});
