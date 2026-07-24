import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { theme, themeAlpha } from '../../theme';
import type { EditorCommands } from '../../editor/store';
import { removeItemsFromState } from '../../editor/multiSelect';
import { canMulticamItem, runMulticamSync } from '../../multicam/sync';
import { TRANSITION_LABELS, ZOOM_SHAPE_LABELS, type TimelineItem, type TimelineState, type TransitionItem } from '../../editor/types';
import { ALL_FX, LUT_EFFECTS } from '../../gl/fx/effects';
import { Icon, type IconName } from '../icons';
import { useT } from '../../i18n/locale';

// speed presets for the variable speed submenu
const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

// Clip right-click menu. AI multi-cam synchronization: client audio alignment (src/multicam).

/** effects copied from a clip (the clip's effects[] stack) */
export interface FxClip {
  filters?: TimelineItem['filters'];
  transform?: TimelineItem['transform'];
  zoom?: TimelineItem['zoom'];
  fadeInFrames?: number;
  fadeOutFrames?: number;
}

interface ClipContextMenuProps {
  item: TimelineItem;
  /** Transitions related to this clip(enter/out),For "Applied Effects" to list and remove */
  transitions: TransitionItem[];
  x: number;
  y: number;
  playhead: number;
  commands: EditorCommands;
  /** Active timeline — needed for multi-select batch delete */
  timeline: TimelineState;
  /** Current multi-selection (includes item when right-clicked inside the set) */
  selectedIds: string[];
  fxClip: FxClip | null;
  onCopyFx: (fx: FxClip) => void;
  onClose: () => void;
  /** Export MG animation → ProRes 4444 alpha .mov download */
  onExportMg: (item: TimelineItem) => void;
  /** Convert to video → bake to a video clip in place */
  onConvertToVideo: (item: TimelineItem) => void;
}

const PASTE_HINT = '⌘⌥V';

export function ClipContextMenu({ item, transitions, x, y, playhead, commands, timeline, selectedIds, fxClip, onCopyFx, onClose, onExportMg, onConvertToVideo }: ClipContextMenuProps) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  // Right-click on a multi-selected clip → batch ops on the whole set (NLE convention).
  const batchIds = selectedIds.includes(item.id) && selectedIds.length > 1 ? selectedIds : [item.id];
  const batchN = batchIds.length;
  // Multicam: need ≥2 selected video/audio with media
  const multicamIds = (batchN > 1 ? batchIds : selectedIds.length > 1 ? selectedIds : [])
    .map((id) => timeline.items.find((x) => x.id === id))
    .filter((x): x is TimelineItem => !!x && canMulticamItem(x))
    .map((x) => x.id);
  // If only one selected but right-clicked a media clip, still require multi-select
  const multicamReady = multicamIds.length >= 2;
  const multicamHint = multicamReady
    ? t('Yes {n} Audio alignment of clips', { n: multicamIds.length })
    : batchN < 2 && selectedIds.length < 2
      ? t('Frame selection first 2 videos and above/audio clip')
      : t('Multi-camera synchronization only supports videos with media/audio clip');

  const runMulticam = async () => {
    if (!multicamReady || syncBusy) return;
    setSyncBusy(true);
    setSyncMsg(t('Doing audio alignment...'));
    try {
      // Prefer right-clicked item as reference when it's in the set
      const refId = multicamIds.includes(item.id) ? item.id : undefined;
      const result = await runMulticamSync({
        state: timeline,
        itemIds: multicamIds,
        referenceItemId: refId,
      });
      if (result.changed && result.nextState) commands.applyState(result.nextState);
      setSyncMsg(result.changed
        ? (result.skippedItemIds.length
          ? t('Synced {n} segments, skip {m} a', { n: result.syncedItemIds.length, m: result.skippedItemIds.length })
          : t('Synced {n} fragments', { n: result.syncedItemIds.length }))
        : result.status === 'already_synced'
          ? t('Already aligned (offset less than 1 frame)')
          : t('Unable to align selected fragments (confidence too low or decoding failed)'));
      if (result.changed) {
        // brief toast then close
        window.setTimeout(() => onClose(), 900);
      }
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : t('Multi-camera synchronization failed'));
    } finally {
      setSyncBusy(false);
    }
  };
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const [showSpeed, setShowSpeed] = useState(false);
  const [showApplied, setShowApplied] = useState(false);
  // Use conservative clamping for the initial value, and accurately shrink it after measuring the actual size (weight when expanding sub-areas/changing anchors)
  const [pos, setPos] = useState(() => ({ left: Math.min(x, window.innerWidth - 210), top: Math.min(y, window.innerHeight - 380) }));
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    });
  }, [x, y, showApplied, showSpeed]);

  // Applied performance list:special effects/LUT/Zoom/Transition,Click to remove
  const effects = item.effects ?? [];
  const applied: { key: string; label: string; remove: () => void }[] = [
    ...effects.map((fx) => ({
      key: fx.id,
      label: `${fx.assetId in LUT_EFFECTS ? 'LUT' : t('special effects')} · ${t(ALL_FX[fx.assetId]?.name ?? fx.assetId)}`,
      remove: () => commands.setItemEffects(item.id, effects.filter((e) => e.id !== fx.id)),
    })),
    ...(item.zoom?.shape || (item.zoom?.reframeCurve?.keyframes.length ?? 0) > 0
      ? [{
          key: 'zoom',
          label: t('Zoom · {name}', { name: item.zoom?.shape ? t(ZOOM_SHAPE_LABELS[item.zoom.shape] ?? item.zoom.shape) : item.zoom?.label ?? t('keyframe') }),
          remove: () => commands.setItemZoom(item.id, null),
        }]
      : []),
    ...transitions.map((tr) => ({
      key: tr.id,
      label: t(tr.incomingItemId === item.id ? 'Transition · {name}(enter)' : 'Transition · {name}(out)', { name: t(TRANSITION_LABELS[tr.type] ?? tr.type) }),
      remove: () => commands.removeTransition(tr.id),
    })),
  ];
  const inside = playhead > item.startFrame && playhead < item.startFrame + item.durationInFrames;
  const isVisual = item.kind !== 'audio';
  const isDom = item.kind === 'motion-graphic' || item.kind === 'text'; // DOM clips → alpha MG export
  const canSpeed = item.kind === 'video' || item.kind === 'audio'; // playbackRate only affects av
  const rate = item.playbackRate ?? 1;
  const run = (fn: () => void) => () => { fn(); onClose(); };

  const copyFx = () => onCopyFx({ filters: item.filters, transform: item.transform, zoom: item.zoom, fadeInFrames: item.fadeInFrames, fadeOutFrames: item.fadeOutFrames });
  const pasteFx = () => {
    if (!fxClip) return;
    if (fxClip.filters) commands.setItemFilters(item.id, fxClip.filters);
    if (fxClip.transform) commands.setItemTransform(item.id, fxClip.transform);
    commands.setItemZoom(item.id, fxClip.zoom ?? null);
    commands.setItemFade(item.id, { fadeInFrames: fxClip.fadeInFrames ?? 0, fadeOutFrames: fxClip.fadeOutFrames ?? 0 });
  };

  // keep the menu on-screen:Menu height varies with items/unfolded state changes,If you write a high estimate, it will overflow at the bottom——
  // mountwithunfolded state changesafter量true实SizeAgain夹take(useLayoutEffect run before drawing,No flash)。
  const style: React.CSSProperties = {
    position: 'fixed', left: pos.left, top: pos.top,
    zIndex: 100, minWidth: 200, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto',
    background: theme.panelAlt, border: `0.5px solid ${theme.borderLight}`,
    borderRadius: 5, boxShadow: `0 12px 36px ${themeAlpha.shadow(0.55)}`, padding: 5, fontSize: 12.5, color: theme.text,
  };

  return (
    <div ref={ref} style={style}>
      <Item
        label={syncBusy ? t('Multi-camera synchronization...') : t('AI Multi-camera synchronization')}
        icon="users"
        disabled={!multicamReady || syncBusy}
        onClick={() => { void runMulticam(); }}
      />
      {syncMsg && (
        <div style={{ padding: '4px 9px 6px', fontSize: 11, color: theme.textMuted, lineHeight: 1.35 }}>
          {syncMsg}
        </div>
      )}
      {!multicamReady && !syncMsg && (
        <div style={{ padding: '0 9px 6px', fontSize: 10.5, color: theme.textDim, lineHeight: 1.3 }}>
          {multicamHint}
        </div>
      )}
      <Sep />
      <Item label={t('Copy')} icon="copy" shortcut="⌘C" onClick={run(() => commands.duplicateItem(item.id))} />
      <Item label={t('cut')} icon="scissors" shortcut="C" disabled={!inside} onClick={run(() => commands.splitItem(item.id, playhead))} />
      <Sep />
      <Item label={applied.length ? t('Effect applied ({n}）', { n: applied.length }) : t('Effect applied')} icon="filter" chevron disabled={applied.length === 0}
        onClick={applied.length ? () => setShowApplied((v) => !v) : undefined} />
      {showApplied && applied.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 6px 6px 35px' }}>
          {applied.map((a) => (
            <button key={a.key} title={t('Click to remove')} onClick={run(a.remove)} style={appliedRow}
              onMouseEnter={(e) => { e.currentTarget.style.background = theme.bg; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{a.label}</span>
              <span style={{ color: theme.textDim, flexShrink: 0 }}>×</span>
            </button>
          ))}
        </div>
      )}
      <Item label={t('copy effect')} icon="sparkles" disabled={!isVisual} onClick={run(copyFx)} />
      <Item label={t('Paste effect')} icon="clipboard" shortcut={PASTE_HINT} disabled={!isVisual || !fxClip} onClick={run(pasteFx)} />
      <Item label={rate !== 1 ? t('variable speed ({rate}×）', { rate }) : t('variable speed')} icon="clock" chevron disabled={!canSpeed}
        onClick={canSpeed ? () => setShowSpeed((v) => !v) : undefined} />
      {showSpeed && canSpeed && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, padding: '2px 9px 6px 35px' }}>
          {SPEED_PRESETS.map((s) => (
            <button key={s} onClick={run(() => commands.setItemSpeed(item.id, s))}
              style={{
                cursor: 'pointer', fontSize: 11, padding: '3px 8px', borderRadius: 5,
                border: `0.5px solid ${s === rate ? theme.accent : theme.border}`,
                background: s === rate ? theme.accent : 'none', color: s === rate ? theme.onAccent : theme.text,
              }}>{s}×</button>
          ))}
        </div>
      )}
      <Sep />
      <Item label={t('Export MG animation')} icon="download" disabled={!isDom} onClick={run(() => onExportMg(item))} />
      <Item label={t('Convert to video')} icon="film" disabled={item.kind === 'audio'} onClick={run(() => onConvertToVideo(item))} />
      <Sep />
      <Item
        label={batchN > 1 ? t('Delete ({n}）', { n: batchN }) : t('Delete')}
        icon="trash"
        danger
        shortcut="⌫"
        onClick={run(() => {
          if (batchN === 1) commands.removeItem(batchIds[0]!);
          else commands.applyState(removeItemsFromState(timeline, batchIds, false));
        })}
      />
      <Item
        label={batchN > 1 ? t('ripple delete ({n}）', { n: batchN }) : t('Ripple removal (joint seam)')}
        icon="trash"
        danger
        shortcut="⇧⌫"
        onClick={run(() => {
          if (batchN === 1) commands.rippleDeleteItem(batchIds[0]!);
          else commands.applyState(removeItemsFromState(timeline, batchIds, true));
        })}
      />
    </div>
  );
}

const appliedRow: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none',
  borderRadius: 5, padding: '4px 8px', fontSize: 11.5, color: theme.text, cursor: 'pointer',
};

function Sep() {
  return <div style={{ height: 0.5, background: theme.border, margin: '5px 6px' }} />;
}

function Item({ label, icon, shortcut, disabled, danger, pro, chevron, onClick }: {
  label: string; icon: IconName; shortcut?: string; disabled?: boolean; danger?: boolean; pro?: boolean; chevron?: boolean; onClick?: () => void;
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
      <span style={{ width: 16, display: 'grid', placeItems: 'center', lineHeight: 0, color: danger ? theme.accent : theme.textDim }}><Icon name={icon} size={15} /></span>
      <span style={{ flex: 1 }}>{label}</span>
      {pro && <span style={{ fontSize: 9, fontWeight: 700, color: theme.accent, border: `0.5px solid ${theme.accent}`, borderRadius: 3, padding: '0 3px' }}>PRO</span>}
      {chevron && <span style={{ color: theme.textDim }}>›</span>}
      {shortcut && <span style={{ color: theme.textDim, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>{shortcut}</span>}
    </button>
  );
}
