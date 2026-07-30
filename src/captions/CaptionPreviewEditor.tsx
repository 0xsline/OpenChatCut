import { useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { TimelineState } from '../editor/types';
import type { CaptionsData } from './types';
import { CAPTION_STYLES } from './styles';
import { containerStyle, wordStyle } from './renderStyles';
import { buildCues, fmtCueMs } from './captionCues';
import {
  captionPreviewLayoutPatch,
  captionPreviewStylePatch,
  captionPreviewTextPatch,
  findCaptionPreviewTarget,
} from './captionPreviewTarget';
import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';

// 预览画布上的字幕直编层:点画面字幕→选中框+浮动工具条(AI 编辑/样式/字号)。
// 编辑器侧 overlay,不进合成:几何靠对 containerStyle 传"显示区 px 尺寸"复算,
// 命中盒是同字体的透明文本副本(与真渲染同版式)。单流文本改动走
// cueTextPatch,手动车道直接改对应 cue;样式/字号/颜色/位置均走 updateCaptions,可撤销。
// 拖拽:按住字幕移动 → 松手一次性提交 layout 偏移(一步 undo);拖动中显示实体
// 幽灵跟手,松手后合成层落到同一位置。样式全走 cc-capedit-* 类(令牌,随皮肤)。

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
/** 文字颜色快捷色板(白/黑 + 常用强调色) */
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
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [frame, setFrame] = useState(0);
  const [selected, setSelected] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [pop, setPop] = useState<'styles' | 'color' | null>(null);
  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null);
  const dragRef = useRef<DragRef | null>(null);

  // 显示区尺寸(外层 wrapper 已按画布比例定形,inset-0 即视频区 1:1)
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setBox({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // 跟播放头(Player frameupdate)
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

  // 换句即退出选中;点 overlay 外部也退出
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
    if (!selected) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setSelected(false); setEditing(false); setPop(null);
      }
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [selected]);

  if (!target || !cue || !box) {
    return <div ref={rootRef} style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }} />;
  }

  const preset = target.preset;
  const block = containerStyle(preset, captions.template, box.w, box.h, target.layout);
  const textCss = {
    ...wordStyle(preset, false),
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
    onUpdateCaptions(captionPreviewStylePatch(captions, target, { color: hex }));
  };
  // ── 拖拽移动(bottom 锚 offsetYRatio 正向朝上,containerStyle 里取负号) ──
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
      // 未达拖拽阈值 = 点击选中
      setSelected(true);
      playerRef.current?.pause();
    }
    setDrag(null);
  };

  const curColor = preset.color;

  return (
    <div ref={rootRef} style={{ position: 'absolute', inset: 0, zIndex: 4, pointerEvents: 'none', overflow: 'visible' }}>
      <div style={{ ...block, pointerEvents: 'none' }}>
        <div style={{ position: 'relative', pointerEvents: 'auto', maxWidth: '100%', transform: drag ? `translate(${drag.dx}px, ${drag.dy}px)` : undefined }}>
          {editing ? (
            <textarea
              value={draft}
              autoFocus
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveText(draft); }
                if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); }
              }}
              style={{
                ...textCss, background: '#000000d9', color: preset.color, font: 'inherit', fontSize: 'inherit',
                width: 'max(220px, 100%)', textAlign: 'center', border: '1.5px solid var(--cc-accent)',
                outline: 'none', resize: 'none', lineHeight: 1.25,
              }}
            />
          ) : (
            // 命中盒:同版式文本副本。平时透明(真字幕在合成层),拖动中显形当幽灵跟手
            <div
              className="cc-capedit-hit"
              role="button"
              title={t('点击选中字幕；拖动移动位置；双击直接改文字')}
              onPointerDown={onHitPointerDown}
              onPointerMove={onHitPointerMove}
              onPointerUp={onHitPointerUp}
              onDoubleClick={() => { setSelected(true); setEditing(true); setDraft(cue.text); playerRef.current?.pause(); }}
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

          {/* 浮动工具条(AI 编辑 | 文字/样式/颜色 | 字号 | 删) */}
          {selected && !drag && (
            <div className="cc-capedit-bar" onPointerDown={(e) => e.stopPropagation()}>
              {onSeedChat && (
                <>
                  <button type="button" className="cc-capedit-btn ai" title={t('让 AI 改写这句')}
                    onClick={() => onSeedChat(t('优化这句字幕（{time} 处，保持时间不变）：「{text}」', { time: fmtCueMs(cue.start), text: cue.text }))}>
                    <Icon name="sparkles" size={12} />{t('AI 编辑')}
                  </button>
                  <span className="cc-capedit-divider" aria-hidden />
                </>
              )}
              <button type="button" className="cc-capedit-btn" title={t('编辑文字')} onClick={() => { setEditing(true); setDraft(cue.text); }}>
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
                      onClick={() => { onUpdateCaptions({ template: st.id }); setPop(null); }}>
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
