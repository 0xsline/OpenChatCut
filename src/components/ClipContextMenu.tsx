import { useEffect, useRef } from 'react';
import { theme } from '../theme';
import type { EditorCommands } from '../editor/store';
import type { TimelineItem } from '../editor/types';

// Clip right-click menu (source Hyt @entry.js:195762). Item order + labels are
// faithful to the source; PRO / not-yet-built actions render disabled like the
// source greys 多机位同步 and PRO-badges 导出MG / 转为视频.

/** effects copied from a clip (source: the clip's effects[] stack) */
export interface FxClip {
  filters?: TimelineItem['filters'];
  transform?: TimelineItem['transform'];
  zoom?: TimelineItem['zoom'];
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

interface ClipContextMenuProps {
  item: TimelineItem;
  x: number;
  y: number;
  playhead: number;
  commands: EditorCommands;
  fxClip: FxClip | null;
  onCopyFx: (fx: FxClip) => void;
  onClose: () => void;
}

const PASTE_HINT = '⌘⌥V';

export function ClipContextMenu({ item, x, y, playhead, commands, fxClip, onCopyFx, onClose }: ClipContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const inside = playhead > item.startFrame && playhead < item.startFrame + item.durationInFrames;
  const isVisual = item.kind !== 'audio';
  const run = (fn: () => void) => () => { fn(); onClose(); };

  const copyFx = () => onCopyFx({ filters: item.filters, transform: item.transform, zoom: item.zoom, fadeInFrames: item.fadeInFrames, fadeOutFrames: item.fadeOutFrames });
  const pasteFx = () => {
    if (!fxClip) return;
    if (fxClip.filters) commands.setItemFilters(item.id, fxClip.filters);
    if (fxClip.transform) commands.setItemTransform(item.id, fxClip.transform);
    commands.setItemZoom(item.id, fxClip.zoom ?? null);
    commands.setItemFade(item.id, { fadeInFrames: fxClip.fadeInFrames ?? 0, fadeOutFrames: fxClip.fadeOutFrames ?? 0 });
  };

  // keep the menu on-screen
  const style: React.CSSProperties = {
    position: 'fixed', left: Math.min(x, window.innerWidth - 210), top: Math.min(y, window.innerHeight - 380),
    zIndex: 100, minWidth: 200, background: theme.panelAlt, border: `1px solid ${theme.borderLight}`,
    borderRadius: 10, boxShadow: '0 12px 36px rgba(0,0,0,0.55)', padding: 5, fontSize: 12.5, color: theme.text,
  };

  return (
    <div ref={ref} style={style}>
      <Item label="AI 多机位同步" icon="⧉" disabled />
      <Sep />
      <Item label="复制" icon="⧉" shortcut="⌘C" onClick={run(() => commands.duplicateItem(item.id))} />
      <Item label="切分" icon="✂" shortcut="C" disabled={!inside} onClick={run(() => commands.splitItem(item.id, playhead))} />
      <Sep />
      <Item label="复制效果" icon="✦" disabled={!isVisual} onClick={run(copyFx)} />
      <Item label="粘贴效果" icon="⧉" shortcut={PASTE_HINT} disabled={!isVisual || !fxClip} onClick={run(pasteFx)} />
      <Item label="快速" icon="⏱" chevron disabled />
      <Sep />
      <Item label="导出 MG 动画" icon="⭳" pro disabled />
      <Item label="转为视频" icon="▦" pro disabled />
      <Sep />
      <Item label="删除" icon="🗑" danger shortcut="⌫" onClick={run(() => commands.removeItem(item.id))} />
      <Item label="波纹删除（合缝）" icon="⇥" danger shortcut="⇧⌫" onClick={run(() => commands.rippleDeleteItem(item.id))} />
    </div>
  );
}

function Sep() {
  return <div style={{ height: 1, background: theme.border, margin: '5px 6px' }} />;
}

function Item({ label, icon, shortcut, disabled, danger, pro, chevron, onClick }: {
  label: string; icon: string; shortcut?: string; disabled?: boolean; danger?: boolean; pro?: boolean; chevron?: boolean; onClick?: () => void;
}) {
  return (
    <button disabled={disabled} onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', background: 'none', border: 'none',
        borderRadius: 6, padding: '7px 9px', fontSize: 12.5, cursor: disabled ? 'default' : 'pointer',
        color: disabled ? theme.textDim : danger ? theme.accent : theme.text, opacity: disabled ? 0.45 : 1,
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = theme.bg; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
      <span style={{ width: 16, textAlign: 'center', fontSize: 12 }}>{icon}</span>
      <span style={{ flex: 1 }}>{label}</span>
      {pro && <span style={{ fontSize: 9, fontWeight: 700, color: theme.accent, border: `1px solid ${theme.accent}`, borderRadius: 3, padding: '0 3px' }}>PRO</span>}
      {chevron && <span style={{ color: theme.textDim }}>›</span>}
      {shortcut && <span style={{ color: theme.textDim, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>{shortcut}</span>}
    </button>
  );
}
