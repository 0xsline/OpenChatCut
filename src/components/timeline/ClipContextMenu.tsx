import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { theme } from '../../theme';
import type { EditorCommands } from '../../editor/store';
import { removeItemsFromState } from '../../editor/multiSelect';
import { canMulticamItem, runMulticamSync } from '../../multicam/sync';
import { TRANSITION_LABELS, ZOOM_SHAPE_LABELS, type TimelineItem, type TimelineState, type TransitionItem } from '../../editor/types';
import { ALL_FX, LUT_EFFECTS } from '../../gl/fx/effects';
import { Icon, type IconName } from '../icons';
import { useT } from '../../i18n/locale';

// speed presets for the 变速 submenu
const SPEED_PRESETS = [0.25, 0.5, 1, 1.5, 2, 4] as const;

// Clip right-click menu. AI 多机位同步:客户端音频对齐(src/multicam)。

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
  /** 与本片段相关的转场(入/出),供「已应用效果」列出与移除 */
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
  /** 导出 MG 动画 → ProRes 4444 alpha .mov download */
  onExportMg: (item: TimelineItem) => void;
  /** 转为视频 → bake to a video clip in place */
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
    ? t('对 {n} 个片段做音频对齐', { n: multicamIds.length })
    : batchN < 2 && selectedIds.length < 2
      ? t('先框选 2 个及以上视频/音频片段')
      : t('多机位同步只支持带媒体的视频/音频片段');

  const runMulticam = async () => {
    if (!multicamReady || syncBusy) return;
    setSyncBusy(true);
    setSyncMsg(t('正在做音频对齐…'));
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
          ? t('已同步 {n} 个片段，跳过 {m} 个', { n: result.syncedItemIds.length, m: result.skippedItemIds.length })
          : t('已同步 {n} 个片段', { n: result.syncedItemIds.length }))
        : result.status === 'already_synced'
          ? t('已经对齐（偏移小于 1 帧）')
          : t('无法对齐所选片段（置信度过低或解码失败）'));
      if (result.changed) {
        // brief toast then close
        window.setTimeout(() => onClose(), 900);
      }
    } catch (e) {
      setSyncMsg(e instanceof Error ? e.message : t('多机位同步失败'));
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
  // 初值用保守夹取,量到真实尺寸后精确收拢(展开子区/换 anchor 时重量)
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

  // 已应用效果清单:特效/LUT/缩放/转场,点击即移除
  const effects = item.effects ?? [];
  const applied: { key: string; label: string; remove: () => void }[] = [
    ...effects.map((fx) => ({
      key: fx.id,
      label: `${fx.assetId in LUT_EFFECTS ? 'LUT' : t('特效')} · ${t(ALL_FX[fx.assetId]?.name ?? fx.assetId)}`,
      remove: () => commands.setItemEffects(item.id, effects.filter((e) => e.id !== fx.id)),
    })),
    ...(item.zoom?.shape || (item.zoom?.reframeCurve?.keyframes.length ?? 0) > 0
      ? [{
          key: 'zoom',
          label: t('缩放 · {name}', { name: item.zoom?.shape ? t(ZOOM_SHAPE_LABELS[item.zoom.shape] ?? item.zoom.shape) : item.zoom?.label ?? t('关键帧') }),
          remove: () => commands.setItemZoom(item.id, null),
        }]
      : []),
    ...transitions.map((tr) => ({
      key: tr.id,
      label: t(tr.incomingItemId === item.id ? '转场 · {name}（入）' : '转场 · {name}（出）', { name: t(TRANSITION_LABELS[tr.type] ?? tr.type) }),
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

  // keep the menu on-screen:菜单高度随条目/展开态变化,写死估高会在底部溢出——
  // 挂载与展开态变化后量真实尺寸再夹取(useLayoutEffect 在绘制前跑,不闪)。
  const style: React.CSSProperties = {
    position: 'fixed', left: pos.left, top: pos.top,
    zIndex: 100, minWidth: 200, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto',
    background: theme.panelAlt, border: `0.5px solid ${theme.borderLight}`,
    borderRadius: 5, boxShadow: '0 12px 36px rgba(0,0,0,0.55)', padding: 5, fontSize: 12.5, color: theme.text,
  };

  return (
    <div ref={ref} style={style}>
      <Item
        label={syncBusy ? t('多机位同步中…') : t('AI 多机位同步')}
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
      <Item label={t('复制')} icon="copy" shortcut="⌘C" onClick={run(() => commands.duplicateItem(item.id))} />
      <Item label={t('切分')} icon="scissors" shortcut="C" disabled={!inside} onClick={run(() => commands.splitItem(item.id, playhead))} />
      <Sep />
      <Item label={applied.length ? t('已应用效果（{n}）', { n: applied.length }) : t('已应用效果')} icon="filter" chevron disabled={applied.length === 0}
        onClick={applied.length ? () => setShowApplied((v) => !v) : undefined} />
      {showApplied && applied.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 6px 6px 35px' }}>
          {applied.map((a) => (
            <button key={a.key} title={t('点击移除')} onClick={run(a.remove)} style={appliedRow}
              onMouseEnter={(e) => { e.currentTarget.style.background = theme.bg; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{a.label}</span>
              <span style={{ color: theme.textDim, flexShrink: 0 }}>×</span>
            </button>
          ))}
        </div>
      )}
      <Item label={t('复制效果')} icon="sparkles" disabled={!isVisual} onClick={run(copyFx)} />
      <Item label={t('粘贴效果')} icon="clipboard" shortcut={PASTE_HINT} disabled={!isVisual || !fxClip} onClick={run(pasteFx)} />
      <Item label={rate !== 1 ? t('变速（{rate}×）', { rate }) : t('变速')} icon="clock" chevron disabled={!canSpeed}
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
      <Item label={t('导出 MG 动画')} icon="download" disabled={!isDom} onClick={run(() => onExportMg(item))} />
      <Item label={t('转为视频')} icon="film" disabled={item.kind === 'audio'} onClick={run(() => onConvertToVideo(item))} />
      <Sep />
      <Item
        label={batchN > 1 ? t('删除（{n}）', { n: batchN }) : t('删除')}
        icon="trash"
        danger
        shortcut="⌫"
        onClick={run(() => {
          if (batchN === 1) commands.removeItem(batchIds[0]!);
          else commands.applyState(removeItemsFromState(timeline, batchIds, false));
        })}
      />
      <Item
        label={batchN > 1 ? t('波纹删除（{n}）', { n: batchN }) : t('波纹删除（合缝）')}
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
