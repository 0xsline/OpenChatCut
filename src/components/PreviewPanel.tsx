import type { RefObject } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { theme } from '../theme';
import { TimelineComposition } from '../editor/TimelineComposition';
import { timelineDuration, ASPECT_PRESETS, type AspectFit, type TimelineState } from '../editor/types';

interface PreviewPanelProps {
  state: TimelineState;
  playerRef: RefObject<PlayerRef | null>;
  onSetAspect: (width: number, height: number, fit?: AspectFit) => void;
}

export function PreviewPanel({ state, playerRef, onSetAspect }: PreviewPanelProps) {
  const duration = timelineDuration(state);
  const fit: AspectFit = state.fit ?? 'contain';
  return (
    <section style={{ display: 'flex', flexDirection: 'column', background: theme.panel, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <div style={{ padding: '7px 16px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ fontSize: 12, color: theme.textDim }}>预览</span>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', gap: 3 }}>
          {ASPECT_PRESETS.map((p) => {
            const active = state.width === p.width && state.height === p.height;
            return (
              <button key={p.label} onClick={() => onSetAspect(p.width, p.height, fit)} title={`画布 ${p.label}`}
                style={{ ...ratioBtn, background: active ? theme.accent : theme.panelAlt, color: active ? '#fff' : theme.textDim, borderColor: active ? theme.accent : theme.border }}>
                {p.label}
              </button>
            );
          })}
        </div>
        <select value={fit} onChange={(e) => onSetAspect(state.width, state.height, e.target.value as AspectFit)} title="内容适配方式"
          style={{ background: theme.panelAlt, color: theme.text, border: `1px solid ${theme.border}`, borderRadius: 5, padding: '3px 6px', fontSize: 11 }}>
          <option value="contain">contain(留边)</option>
          <option value="cover">cover(裁切)</option>
        </select>
      </div>
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

const ratioBtn: React.CSSProperties = { border: `1px solid ${theme.border}`, borderRadius: 5, padding: '3px 8px', fontSize: 11, cursor: 'pointer', fontVariantNumeric: 'tabular-nums' };
