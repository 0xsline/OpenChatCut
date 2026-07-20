// 轨道头单元:类型芯片 + 显隐/静音/锁定/字幕开关/字幕菜单/闪避 + 删除 + 轨名,
// 以及「自动闪避·混音角色」弹层。弹层的单开互斥与外点关闭状态仍归 Timeline
// (两个菜单跨轨道只能开一个),本组件只渲染与转发;字幕菜单以 children 传入挂载。
// 折叠轨已下线——不再提供 collapse 按钮,轨高恒定。
import type { ReactNode } from 'react';
import { theme } from '../../theme';
import { Icon } from '../icons';
import type { EditorCommands } from '../../editor/store';
import type { TrackFlags, TrackId } from '../../editor/types';
import { useT } from '../../i18n/locale';

const flagBtn = (active: boolean): React.CSSProperties => ({
  width: 20, height: 20, display: 'grid', placeItems: 'center',
  background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0,
  color: theme.textMuted, opacity: active ? 0.35 : 1, flexShrink: 0,
});

interface TrackHeadProps {
  trackId: TrackId;
  kind: 'video' | 'audio';
  /** stable alias like "V1"/"A2" (badge shows 视1/音2) */
  alias: string;
  trackName: string;
  config: TrackFlags;
  /** non-empty track (or has transitions) — delete disabled */
  busy: boolean;
  captionsVisible: boolean;
  /** caption menu open on this track → raise head above neighbors */
  menuElevated: boolean;
  width: number;
  commands: EditorCommands;
  onToggleCaptions: () => void;
  onToggleCaptionMenu: (rect: DOMRect) => void;
  onToggleDuckMenu: (rect: DOMRect) => void;
  duckMenuPos: { left: number; top: number } | null;
  onCloseDuckMenu: () => void;
  /** the open CaptionStyleMenu (fixed-positioned), when this track owns it */
  children?: ReactNode;
}

export function TrackHead({
  trackId, kind, alias, trackName, config, busy, captionsVisible, menuElevated, width,
  commands, onToggleCaptions, onToggleCaptionMenu, onToggleDuckMenu, duckMenuPos, onCloseDuckMenu, children,
}: TrackHeadProps) {
  const t = useT();
  const hidden = config.hidden ?? false;
  const muted = config.muted ?? false;
  const locked = config.locked ?? false;
  const nameTitle = config.role === 'anchor' ? `${trackName} · ${t('主轨（闪避）')}`
    : config.role === 'follower' ? `${trackName} · ${t('跟随（闪避）')}`
      : trackName;
  return (
    <div className="cc-track-head" style={{ width, ...(menuElevated ? { zIndex: 40 } : {}) }}>
      <div className="cc-track-head-controls">
        <span className="cc-track-badge" title={t('{name}（{id}）', { name: trackName, id: trackId })} style={{ background: kind === 'video' ? '#5592c7' : '#65a878' }}>{`${t(kind === 'video' ? '视' : '音')}${alias.slice(1)}`}</span>
        <button style={flagBtn(hidden)} title={hidden ? t('显示轨道') : t('隐藏轨道')} onClick={() => commands.toggleTrackFlag(trackId, 'hidden')}><Icon name={hidden ? 'eyeOff' : 'eye'} size={14} /></button>
        <button style={flagBtn(muted)} title={muted ? t('取消静音') : t('静音轨道')} onClick={() => commands.toggleTrackFlag(trackId, 'muted')}><Icon name={muted ? 'volumeOff' : 'volume'} size={14} /></button>
        <button style={{ ...flagBtn(false), color: locked ? theme.gold : theme.textMuted }} title={locked ? t('解锁轨道') : t('锁定轨道（禁止移动 / 裁剪 / 删除 / 落轨）')} onClick={() => commands.toggleTrackFlag(trackId, 'locked')}><Icon name={locked ? 'lock' : 'unlock'} size={14} /></button>
        <button style={flagBtn(!captionsVisible)} title={captionsVisible ? t('关闭字幕') : t('开启字幕')} onClick={onToggleCaptions}><Icon name="captions" size={14} /></button>
        <button data-caption-menu-trigger style={flagBtn(false)} title={t('字幕样式与翻译')} onClick={(e) => onToggleCaptionMenu(e.currentTarget.getBoundingClientRect())}><Icon name="chevronDown" size={12} /></button>
        <button data-duck-menu-trigger style={{ ...flagBtn(false), color: config.role === 'anchor' || config.role === 'follower' ? theme.gold : theme.textMuted }} title={t('自动闪避（混音角色：主轨说话 / 跟随背景乐）')} onClick={(e) => onToggleDuckMenu(e.currentTarget.getBoundingClientRect())}><Icon name="sliders" size={13} /></button>
        <button
          type="button"
          className="cc-track-fixed-action"
          disabled={busy}
          title={busy ? t('只能删除空轨道') : t('删除轨道')}
          onClick={() => commands.deleteTracks([trackId])}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
      <span className="cc-track-name" title={nameTitle}>
        {trackName}
        {config.role === 'anchor' ? ` · ${t('主轨')}` : config.role === 'follower' ? ` · ${t('跟随')}` : ''}
      </span>
      {children}
      {duckMenuPos && (
        <DuckMenu trackId={trackId} config={config} pos={duckMenuPos} commands={commands} onClose={onCloseDuckMenu} />
      )}
    </div>
  );
}

// Duck (自动闪避) role menu is a track-head menu item, not a
// permanent widget. Sets the per-track role (anchor speech / follower music) + duck depth;
// the engine (TimelineComposition duckGain) already reacts to it.
function DuckMenu({ trackId, config, pos, commands, onClose }: {
  trackId: TrackId;
  config: TrackFlags;
  pos: { left: number; top: number };
  commands: EditorCommands;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <div className="cc-caption-style-menu cc-duck-menu" style={{ position: 'fixed', left: pos.left, top: pos.top }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="cc-caption-style-title">{t('自动闪避 · 混音角色')}</div>
      <div className="cc-caption-style-list">
        {([
          { role: null, label: '关闭', hint: '不参与自动闪避' },
          { role: 'anchor', label: '主轨 · 说话', hint: '说话时触发其它轨闪避' },
          { role: 'follower', label: '跟随 · 背景音乐', hint: '主轨说话时自动压低' },
        ] as const).map((opt) => (
          <button key={opt.label} className={(config.role ?? null) === opt.role ? 'active' : ''}
            onClick={() => { commands.updateTrack(trackId, { role: opt.role }); if (opt.role !== 'follower') onClose(); }}>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.25 }}>
              <span>{t(opt.label)}</span>
              <span style={{ fontSize: 11, color: theme.textMuted }}>{t(opt.hint)}</span>
            </span>
          </button>
        ))}
      </div>
      {config.role === 'follower' && (
        <div style={{ borderTop: `0.5px solid ${theme.border}`, padding: '7px 10px 9px' }}>
          <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 5 }}>{t('闪避强度（dB）')}</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {[-6, -12, -18, -24].map((db) => {
              const cur = config.audioRouting?.duckDepthDb ?? -12;
              return (
                <button key={db} onClick={() => commands.updateTrack(trackId, { audioRouting: { duckDepthDb: db } })}
                  style={{ flex: 1, padding: '4px 0', borderRadius: 4, border: `0.5px solid ${theme.borderLight}`, cursor: 'pointer',
                    background: cur === db ? `color-mix(in srgb, ${theme.select} 30%, ${theme.hover})` : 'transparent', color: cur === db ? theme.textStrong : theme.textMuted, fontSize: 11 }}>
                  {db}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
