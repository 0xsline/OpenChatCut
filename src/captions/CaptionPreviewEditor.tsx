import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineState } from '../editor/types';
import type { CaptionsData } from './types';
import { CAPTION_STYLES } from './styles';
import { captionPreviewTextColor, captionPreviewTextColorPatch, containerStyle, wordStyle } from './renderStyles';
import { buildCues, fmtCueMs } from './captionCues';
import {
  captionPreviewLayoutPatch,
  captionPreviewNudgePatch,
  captionPreviewStylePatch,
  captionPreviewTextPatch,
  findCaptionPreviewTarget,
  type CaptionPreviewNudgeDirection,
} from './captionPreviewTarget';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';
import { captionTemplatePatch } from './captionTemplatePatch';
import { captionPreviewOutsideClickAction } from './captionPreviewToolbar';

// Preview the caption direct editing layer on the canvas: click on the screen caption → check box + floating toolbar (AI Edit/Style/Font Size).
// Editor side overlay, no synthesis: geometry is recalculated by passing "display area px size" to containerStyle,
// The hit box is a transparent copy of the text in the same font (same layout as true rendering). Single stream text changes
// cueTextPatch, the manual lane is directly changed to correspond to the cue; the style/font size/color/position are all updated with updateCaptions, which can be revoked.
// Drag and drop: press and hold the caption to move → let go and submit the layout offset at once (one step undo); display the entity during dragging
// The ghost follows the hand, and the synthetic layer falls to the same position after letting go. All styles use cc-capedit-* classes (tokens, with skins).

interface CaptionPreviewEditorProps {
  state: TimelineState;
  captions: CaptionsData;
  playerRef: RefObject<PlayerRef | null>;
  onUpdateCaptions: (patch: Partial<CaptionsData>) => void;
  onSeedChat?: (text: string) => void;
  autoEditLaneId?: string;
  onAutoEditHandled?: () => void;
}

const FONT_STEP = 1.12;
const clampFont = (v: number): number => Math.min(0.14, Math.max(0.02, v));
const DRAG_THRESHOLD = 4;
const ARROW_NUDGE_DIRECTION: Partial<Record<string, CaptionPreviewNudgeDirection>> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
};
/** Text color quick color palette (white/black + common accent colors) */
const COLOR_SWATCHES = ['#ffffff', '#0a0a0a', '#FFD84A', '#FF5A5A', '#6EE7F9', '#7CFF9B', '#FF8FD1', '#FFA94D'];

interface DragRef {
  startX: number; startY: number;
  baseX: number; baseY: number;
  ySign: 1 | -1;
  moved: boolean;
}

export function CaptionPreviewEditor({ state, captions, playerRef, onUpdateCaptions, onSeedChat, autoEditLaneId, onAutoEditHandled }: CaptionPreviewEditorProps) {
  const t = useT();
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [selected, setSelected] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [pop, setPop] = useState<'styles' | 'color' | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const dragRef = useRef<DragRef | null>(null);

  // Display area size (the outer wrapper has been shaped according to the canvas ratio, inset-0 is the video area 1:1)
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Follow the playhead (Player frameupdate)
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    setFrame(player.getCurrentFrame());
    const onFrame = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    player.addEventListener('frameupdate', onFrame);
    return () => player.removeEventListener('frameupdate', onFrame);
  }, [playerRef]);

  const rows = useMemo(
    () => (captions.enabled && !captions.sourceEntries?.length ? buildCues(captions, state.items, state.fps) : []),
    [captions, state.items, state.fps],
  );
  const ms = (frame / state.fps) * 1000;
  const target = useMemo(
    () => findCaptionPreviewTarget(captions, state.items, state.fps, ms, rows),
    [captions, state.items, state.fps, ms, rows],
  );
  const cue = target?.cue;

  // In other words, exit the selection; click on overlay to exit also
  useEffect(() => { setSelected(false); setEditing(false); setPop(null); }, [target?.key]);
  useEffect(() => {
    if (!autoEditLaneId || target?.kind !== 'manual' || target.laneId !== autoEditLaneId || !cue) return;
    playerRef.current?.pause();
    setSelected(true);
    setEditing(true);
    setDraft(cue.text);
    onAutoEditHandled?.();
  }, [autoEditLaneId, cue, onAutoEditHandled, playerRef, target]);
  useEffect(() => {
    if (!selected || (!editing && pop === null)) return;
    const onDown = (event: PointerEvent) => {
      const node = event.target instanceof Node ? event.target : null;
      const action = captionPreviewOutsideClickAction({
        editing,
        popoverOpen: pop !== null,
        insideEditor: Boolean(node && editorRef.current?.contains(node)),
        insideToolbar: Boolean(node && toolbarRef.current?.contains(node)),
        draftChanged: Boolean(target && draft !== target.cue.text),
      });
      if (action.commitDraft && target) {
        const patch = captionPreviewTextPatch(captions, target, draft);
        if (patch) onUpdateCaptions(patch);
      }
      if (action.closeEditor) setEditing(false);
      if (action.closePopover) setPop(null);
      if (node && rootRef.current && !rootRef.current.contains(node)) {
        setSelected(false);
        setEditing(false);
        setPop(null);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [captions, draft, editing, onUpdateCaptions, pop, selected, target]);

  if (!target || !cue || !box) {
    return <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />;
  }

  const preset = target.preset;
  const currentTextColor = captionPreviewTextColor(preset);
  const block = containerStyle(preset, captions.template, box.w, box.h, target.layout);
  const textCss = {
    ...wordStyle(preset, !preset.wholeLine),
    background: preset.wholeLine && preset.background ? preset.background : 'transparent',
    borderRadius: 6,
    padding: preset.wholeLine && preset.background ? '0.1em 0.42em' : 0,
    whiteSpace: 'pre-wrap' as const,
  };

  const saveText = (text: string) => {
    const patch = captionPreviewTextPatch(captions, target, text);
    if (patch) onUpdateCaptions(patch);
    setEditing(false);
  };
  const bumpFont = (dir: 1 | -1) => {
    const next = clampFont(dir > 0 ? preset.fontSize * FONT_STEP : preset.fontSize / FONT_STEP);
    onUpdateCaptions(captionPreviewStylePatch(captions, target, { fontSize: next }));
  };
  const setColor = (hex: string) => {
    onUpdateCaptions(captionPreviewStylePatch(captions, target, captionPreviewTextColorPatch(preset, hex)));
  };
  // ── Drag and move (bottom anchor offsetYRatio positive upward, containerStyle takes the negative sign) ──
  const anchorV = (() => {
    const a = target.layout?.anchor ?? 'bottom-center';
    return a.startsWith('top') ? 'top' : (a.startsWith('middle') || a === 'center') ? 'middle' : 'bottom';
  })();
  const onHitPointerDown = (e: React.PointerEvent) => {
    if (editing) return;
    e.stopPropagation();
    e.preventDefault();
    // Freeze and select on press. A human click can span multiple playback
    // frames; waiting for pointerup allowed the active cue to change first.
    setSelected(true);
    playerRef.current?.pause();
    (e.currentTarget as HTMLElement).focus({ preventScroll: true });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX, startY: e.clientY,
      baseX: target.layout?.offsetXRatio ?? 0,
      baseY: target.layout?.offsetYRatio ?? 0,
      ySign: anchorV === 'bottom' ? -1 : 1,
      moved: false,
    };
  };
  const onHitPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      d.moved = true;
      playerRef.current?.pause();
    }
    if (d.moved) setDrag({ dx, dy });
  };
  const onHitPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.moved && box) {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      onUpdateCaptions(captionPreviewLayoutPatch(captions, target, {
          anchor: target.layout?.anchor ?? 'bottom-center',
          offsetXRatio: d.baseX + dx / box.w,
          offsetYRatio: d.baseY + d.ySign * (dy / box.h),
      }));
      setSelected(true);
    } else {
      // Drag threshold not reached = click to select
      setSelected(true);
      playerRef.current?.pause();
    }
    setDrag(null);
  };
  const onHitKeyDown = (e: React.KeyboardEvent) => {
    if (!selected || editing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const direction = ARROW_NUDGE_DIRECTION[e.key];
    if (!direction) return;
    e.preventDefault();
    e.stopPropagation();
    playerRef.current?.pause();
    onUpdateCaptions(captionPreviewNudgePatch(captions, target, direction));
  };

  const curColor = currentTextColor;

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, zIndex: 4, pointerEvents: 'none', overflow: 'visible' }}>
      <div style={{ ...block, pointerEvents: 'none' }}>
        <div style={{ position: 'relative', pointerEvents: 'auto', maxWidth: '100%', transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined }}>
          {editing ? (
            <textarea
              ref={editorRef}
              value={draft}
              autoFocus
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveText(draft); }
                if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
              }}
              style={{
                ...textCss, background: '#000000d9', color: currentTextColor, font: 'inherit', fontSize: 'inherit',
                width: 'max(220px, 100%)', textAlign: 'center', border: '1.5px solid var(--cc-accent)',
                outline: 'none', resize: 'none', lineHeight: 1.25,
              }}
            />
          ) : (
            // Hitbox: A copy of the same layout text. Normally transparent (the real captions are on the composite layer), they will appear during dragging when the ghost follows your hand.
            <div
              className="cc-capedit-hit"
              role="button"
              tabIndex={0}
              title={t('点击选中字幕；拖动移动位置；双击直接改文字')}
              onPointerDown={onHitPointerDown}
              onPointerMove={onHitPointerMove}
              onPointerUp={onHitPointerUp}
              onKeyDown={onHitKeyDown}
              onDoubleClick={() => { setSelected(true); setPop(null); setEditing(true); setDraft(cue.text); playerRef.current?.pause(); }}
              style={drag
                ? { ...textCss, opacity: 0.92, cursor: 'grabbing', touchAction: 'none', userSelect: 'none' }
                : { ...textCss, color: 'transparent', WebkitTextStroke: undefined, textShadow: 'none', background: 'transparent', cursor: 'grab', touchAction: 'none', userSelect: 'none' }}
            >
              {cue.text}
            </div>
          )}
          {selected && !editing && !drag && (
            <div className="cc-capedit-frame" aria-hidden />
          )}

          {/* Floating toolbar (AI editing | text/style/color | font size | delete)*/}
          {selected && !drag && (
            <div ref={toolbarRef} className="cc-capedit-bar" onPointerDown={(e) => e.stopPropagation()}>
              {onSeedChat && (
                <>
                  <button type="button" className="cc-capedit-btn ai" title={t('让 AI 改写这句')}
                    onClick={() => onSeedChat(t('优化这句字幕（{time} 处，保持时间不变）：「{text}」', { time: fmtCueMs(cue.start), text: cue.text }))}>
                    <Icon name="sparkles" size={12} />{t('AI 编辑')}
                  </button>
                  <span className="cc-capedit-divider" aria-hidden />
                </>
              )}
              <button type="button" className="cc-capedit-btn" title={t('编辑文字')} onClick={() => {
                setPop(null);
                if (!editing) {
                  setEditing(true);
                  setDraft(cue.text);
                }
              }}>
                <Icon name="pencil" size={12} />{t('文字')}
              </button>
              <button type="button" className={`cc-capedit-btn${pop === 'styles' ? ' on' : ''}`} title={t('字幕样式')} onClick={() => setPop(pop === 'styles' ? null : 'styles')}>Aa</button>
              <button type="button" className={`cc-capedit-btn${pop === 'color' ? ' on' : ''}`} title={t('文字颜色')} onClick={() => setPop(pop === 'color' ? null : 'color')}>
                <span className="cc-capedit-colordot" style={{ background: curColor }} />
              </button>
              <span className="cc-capedit-divider" aria-hidden />
              <button type="button" className="cc-capedit-btn" title={t('缩小字号')} onClick={() => bumpFont(-1)}>A−</button>
              <button type="button" className="cc-capedit-btn" title={t('放大字号')} onClick={() => bumpFont(1)}>A+</button>
              <span className="cc-capedit-divider" aria-hidden />
              <button type="button" className="cc-capedit-btn danger" title={t('删除这句')} onClick={() => saveText('')}>
                <Icon name="trash" size={12} />
              </button>

              {pop === 'styles' && (
                <div className="cc-capedit-pop styles">
                  {CAPTION_STYLES.map((st) => (
                    <button key={st.id} type="button"
                      className={`cc-capedit-styleitem${st.id === captions.template ? ' on' : ''}`}
                      onClick={() => { onUpdateCaptions(captionTemplatePatch(captions, st.id)); setPop(null); }}>
                      {t(st.labelZh)}
                    </button>
                  ))}
                </div>
              )}
              {pop === 'color' && (
                <div className="cc-capedit-pop color">
                  {COLOR_SWATCHES.map((hex) => (
                    <button key={hex} type="button"
                      className={`cc-capedit-swatch${curColor.toLowerCase() === hex.toLowerCase() ? ' on' : ''}`}
                      style={{ background: hex }}
                      title={hex}
                      onClick={() => { setColor(hex); setPop(null); }} />
                  ))}
                  <label className="cc-capedit-custom" title={t('自定义颜色')}>
                    <input
                      type="color"
                      defaultValue={/^#[0-9a-fA-F]{6}$/.test(curColor) ? curColor : '#ffffff'}
                      onBlur={(e) => { setColor(e.target.value); setPop(null); }}
                    />
                    <span>{t('自定义')}</span>
                  </label>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
