// Track header unit: type chip + show/mute/lock/subtitle switch/subtitle menu/dodge + delete + track name,
// And the "Auto-dodge·Mixed character" elastic layer. The single-open mutual exclusion and external point closing status of the elastic layer still belong to the Timeline
// (Only one of the two menus can be opened across tracks). This component only renders and forwards; the subtitle menu is mounted with children passed in.
// The collapse rail is offline - the collapse button is no longer provided and the rail height is constant.
import type { ReactNode } from 'react';
import { theme } from '../../theme';
import { Icon } from '../icons';
import type { EditorCommands } from '../../editor/store';
import type { TrackFlags, TrackId, TrackKind } from '../../editor/types';
import { useT } from '../../i18n/locale';

const flagBtn = (active: boolean): React.CSSProperties => ({
  width: 20, height: 20, display: 'grid', placeItems: 'center',
  background: 'none', border: 'none', borderRadius: 4, cursor: 'pointer', padding: 0,
  color: theme.textMuted, opacity: active ? 0.35 : 1, flexShrink: 0,
});

interface TrackHeadProps {
  trackId: TrackId;
  kind: TrackKind;
  /** stable alias like "C1"/"V1"/"A2" */
  alias: string;
  trackName: string;
  config: TrackFlags;
  /** non-empty track (or has transitions) — delete disabled */
  busy: boolean;
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
  trackId, kind, alias, trackName, config, busy, menuElevated, width,
  commands, onToggleCaptions, onToggleCaptionMenu, onToggleDuckMenu, duckMenuPos, onCloseDuckMenu, children,
}: TrackHeadProps) {
  const t = useT();
  const hidden = config.hidden ?? false;
  const muted = config.muted ?? false;
  const locked = config.locked ?? false;
  const isCaption = kind === 'caption';
  const badgeLabel = kind === 'video' ? 'view' : kind === 'audio' ? 'sound' : 'word';
  const badgeColor = kind === 'video' ? theme.trackVideo : kind === 'audio' ? theme.trackAudioA1 : theme.trackCaption;
  const nameTitle = config.role === 'anchor' ? `${trackName} · ${t('Main track (dodge)')}`
    : config.role === 'follower' ? `${trackName} · ${t('Follow (dodge)')}`
      : trackName;
  return (
    <div className="cc-track-head" style={{ width, ...(menuElevated ? { zIndex: 40 } : {}) }}>
      <div className="cc-track-head-controls">
        <span className="cc-track-badge" title={t('{name}（{id}）', { name: trackName, id: trackId })} style={{ background: badgeColor }}>{`${t(badgeLabel)}${alias.slice(1)}`}</span>
        <button style={flagBtn(hidden)} title={hidden ? t('show track') : t('hidden track')} onClick={isCaption ? onToggleCaptions : () => commands.toggleTrackFlag(trackId, 'hidden')}><Icon name={hidden ? 'eyeOff' : 'eye'} size={14} /></button>
        {!isCaption && <button style={flagBtn(muted)} title={muted ? t('Unmute') : t('Silent track')} onClick={() => commands.toggleTrackFlag(trackId, 'muted')}><Icon name={muted ? 'volumeOff' : 'volume'} size={14} /></button>}
        <button style={{ ...flagBtn(false), color: locked ? theme.gold : theme.textMuted }} title={locked ? t('unlock track') : t('Lock track (disable movement) / Crop / Delete / falling off the track)')} onClick={() => commands.toggleTrackFlag(trackId, 'locked')}><Icon name={locked ? 'lock' : 'unlock'} size={14} /></button>
        {isCaption && <button data-caption-menu-trigger style={flagBtn(false)} title={t('Subtitle styles and translation')} onClick={(e) => onToggleCaptionMenu(e.currentTarget.getBoundingClientRect())}><Icon name="chevronDown" size={12} /></button>}
        {!isCaption && <button data-duck-menu-trigger style={{ ...flagBtn(false), color: config.role === 'anchor' || config.role === 'follower' ? theme.gold : theme.textMuted }} title={t('Autododge (Remix Role: Main Track Talk / Follow the background music)')} onClick={(e) => onToggleDuckMenu(e.currentTarget.getBoundingClientRect())}><Icon name="sliders" size={13} /></button>}
        <button
          type="button"
          className="cc-track-fixed-action"
          disabled={busy}
          title={busy ? t('Only empty tracks can be deleted') : t('Delete track')}
          onClick={() => commands.deleteTracks([trackId])}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
      <span className="cc-track-name" title={nameTitle}>
        {trackName}
        {config.role === 'anchor' ? ` · ${t('main track')}` : config.role === 'follower' ? ` · ${t('follow')}` : ''}
      </span>
      {children}
      {duckMenuPos && (
        <DuckMenu trackId={trackId} config={config} pos={duckMenuPos} commands={commands} onClose={onCloseDuckMenu} />
      )}
    </div>
  );
}

// Duck (auto-dodge) role menu is a track-head menu item, not a
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
      <div className="cc-caption-style-title">{t('Auto dodge · remix character')}</div>
      <div className="cc-caption-style-list">
        {([
          { role: null, label: 'close', hint: 'Does not participate in automatic dodge' },
          { role: 'anchor', label: 'main track · speak', hint: 'Trigger other tracks to dodge when talking' },
          { role: 'follower', label: 'follow · background music', hint: 'Automatically lower the main track when speaking' },
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
          <div style={{ fontSize: 11, color: theme.textMuted, marginBottom: 5 }}>{t('Dodge strength (dB）')}</div>
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
