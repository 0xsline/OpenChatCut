import type { RefObject } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { TimelineComposition } from '../editor/TimelineComposition';
import { timelineDuration, type TimelineState } from '../editor/types';

interface PreviewPanelProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
}

export function PreviewPanel({ state, playerRef }: PreviewPanelProps) {
  const duration = timelineDuration(state);
  return (
    <section style={{ display: 'flex', flexDirection: 'column', background: theme.panel, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <div style={{ padding: '10px 16px', fontSize: 12, color: theme.textDim, borderBottom: `1px solid ${theme.border}` }}>预览</div>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, minHeight: 0, minWidth: 0, overflow: 'hidden', background: theme.bg }}>
        {state.items.length === 0 ? (
          <div style={{ color: theme.textDim, fontSize: 13, textAlign: 'center' }}>
            时间线为空<br />
            <span style={{ fontSize: 12 }}>从左侧「资源库 · G 动画」点击模板即可加到轨道</span>
          </div>
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
              maxWidth: '100%', maxHeight: '100%',
              aspectRatio: `${state.width} / ${state.height}`,
              border: `1px solid ${theme.border}`, borderRadius: 6,
            }}
            controls
            loop
          />
        )}
      </div>
    </section>
  );
}
