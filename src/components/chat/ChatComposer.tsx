import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { theme, themeAlpha } from '../../theme';
import { getLocale, tData, useT } from '../../i18n/locale';
import type { AgentReference } from '../../agent/context';
import { isSelectionRefKind } from '../../agent/selection-refs';
import { Icon, type IconName } from '../icons';
import { CREATIVE_SKILLS, allCreativeSkills, findSkill, setCustomSkills } from '../../agent/skills/skills-catalog';
import { loadCustomSkills } from '../../persist/skillStore';
import { loadAgentSettings, saveAgentSettings, MG_TIERS, type AgentSettings, type MgTier } from '../../agent/settings/agentSettings';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  getAgentModelSnapshot,
  isAgentModelReady,
  selectAgentModel,
  subscribeAgentModels,
} from '../../agent/model-selection';
import { ComposerMoreMenu, ComposerToolbar, type ComposerPopover } from './ComposerToolbar';

/** composer shell height (includes textarea + toolbar); drag the top handle to resize */
const COMPOSER_H_MIN = 88;
const COMPOSER_H_MAX = 420;
const COMPOSER_H_DEFAULT = 112;

export type ChatMode = 'agent' | 'ask';
export type RefItem = AgentReference;

interface ChatComposerProps {
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  onEnhance: () => void;
  enhancing: boolean;
  running: boolean;
  mode: ChatMode;
  onModeChange: (m: ChatMode) => void;
  autoApply: boolean;
  onAutoApplyChange: (v: boolean) => void;
  /** Select mode: pick clips / canvas regions / transcript
   * spans / ruler times as structured references for the next message. */
  selecting: boolean;
  onToggleSelecting: () => void;
  /** active creative-mode skill id (agent_skill), or null = universal */
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
  references: RefItem[];
  onInsertRef: (reference: RefItem) => void;
  /** Structured @ refs attached to the next send (chat_context_entry). */
  selectedRefs?: RefItem[];
  onRemoveRef?: (id: string) => void;
  /** Paste supported files (video/image/audio/gif/svg) straight into the chat.
   * Semantics: Files attached to the chat box are first imported into the media pool and then automatically attached to @ref (not directly uploaded to the timeline). */
  onPasteFiles?: (files: File[]) => void;
  /** true while a pasted file is importing into the pool */
  pasting?: boolean;
  /** last paste import error, or null */
  pasteError?: string | null;
  onDismissPasteError?: () => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}

// Popover above the bar — fixed positioning so parent overflow never clips menus.
function Popover({ children, onClose, w, anchor }: {
  children: ReactNode; onClose: () => void; w?: number; anchor: HTMLElement | null;
}) {
  const [box, setBox] = useState<{ left: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const width = w ?? 220;
      // keep menu on-screen horizontally
      const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
      const bottom = Math.max(8, window.innerHeight - r.top + 8);
      setBox({ left, bottom });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchor, w]);
  if (!box) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80 }} />
      <div style={{
        position: 'fixed', left: box.left, bottom: box.bottom, zIndex: 81,
        minWidth: w ?? 220, maxWidth: 300, maxHeight: Math.min(280, window.innerHeight - box.bottom - 16),
        overflowY: 'auto', background: theme.panelAlt, border: `0.5px solid ${theme.borderLight}`,
    borderRadius: 6, boxShadow: `0 12px 40px ${themeAlpha.shadow(0.5)}`, padding: 6,
      }}>
        {children}
      </div>
    </>
  );
}

// MG three-level quality label (speed|balance|quality)
const TIER_LABELS: Record<MgTier, string> = { speed: '速度', balance: '均衡', quality: '质量' };

const REF_ICON: Record<RefItem['kind'], IconName> = {
  video: 'filePlay', image: 'filePlay', gif: 'image', svg: 'image',
  audio: 'fileHeadphone', 'motion-graphic': 'sparkles', template: 'sparkles',
  // selection-mode picks (item / time / region / transcript references)
  item: 'film', timepoint: 'clock', timerange: 'clock',
  'canvas-region': 'aspect', 'transcript-selection': 'text',
};

function referenceChipText(reference: RefItem): string {
  if (isSelectionRefKind(reference.kind)) return reference.name;
  const displayName = reference.kind === 'template' ? tData(reference.name) : reference.name;
  return `@${displayName}`;
}

export function ChatComposer(props: ChatComposerProps) {
  const t = useT();
  // The skill catalog comes with its own official English name, which can be used directly in English without duplication in the dictionary; the summary is only in Chinese, so use t().
  const skillName = (s: { name: string; nameZh: string }): string =>
    (getLocale() === 'en' ? s.name : s.nameZh);
  const {
    value, onChange, onSubmit, onStop, onEnhance, enhancing, running, mode, onModeChange,
    autoApply, onAutoApplyChange, selecting, onToggleSelecting,
    creativeMode, onCreativeModeChange, references, onInsertRef,
    selectedRefs = [], onRemoveRef, onPasteFiles, pasting, pasteError, onDismissPasteError,
    taRef, placeholder,
  } = props;
  // Hydration custom skill (manage_skill): read IDB → memory registry when mounting, bump triggers re-rendering
  // Make allCreativeSkills()/findSkill reflect custom skills. The real source is IDB, and the manage_skill tool is also the same.
  const [, bumpCustom] = useState(0);
  useEffect(() => {
    loadCustomSkills().then((list) => { setCustomSkills(list); bumpCustom((n) => n + 1); });
  }, []);
  const activeSkill = findSkill(creativeMode);
  const modelState = useSyncExternalStore(
    subscribeAgentModels,
    getAgentModelSnapshot,
    getAgentModelSnapshot,
  );
  const activeModel = modelState.choices.find((choice) => choice.id === modelState.activeId);
  const builtinIds = new Set(CREATIVE_SKILLS.map((s) => s.id));
  const [pop, setPop] = useState<ComposerPopover>(null);
  const [popAnchor, setPopAnchor] = useState<HTMLElement | null>(null);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(() => loadAgentSettings());
  const patchAgent = (patch: Partial<AgentSettings>) => {
    setAgentSettings((prev) => {
      const next = { ...prev, ...patch };
      saveAgentSettings(next);
      return next;
    });
  };
  const closePop = () => { setPop(null); setPopAnchor(null); };
  const toggle = (p: ComposerPopover, el?: EventTarget | null) => {
    const node = el instanceof HTMLElement ? el : null;
    setPop((cur) => {
      if (cur === p) { setPopAnchor(null); return null; }
      setPopAnchor(node);
      return p;
    });
  };
  const modelReady = isAgentModelReady(modelState);
  const canSend = !!value.trim() && !running && modelReady;
  const canEnhance = !!value.trim() && !enhancing && !running && modelReady;
  const sendTitle = modelReady
    ? t('发送 (Enter)')
    : modelState.loaded
      ? t('请先在设置中配置一个模型厂商。')
      : t('正在读取模型配置…');
  const refList = (kind: 'asset' | 'template') =>
    references.filter((r) => (kind === 'template' ? r.kind === 'template' : r.kind !== 'template'));

  const insert = (reference: RefItem) => { onInsertRef(reference); closePop(); taRef.current?.focus(); };

  // Drag up and down to change the height of the input area: top handle + localStorage memory
  const [shellH, setShellH] = usePersistedState('cc.composerShellH', COMPOSER_H_DEFAULT);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  const onResizePointerDown = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: shellH };
  }, [shellH]);
  const onResizePointerMove = useCallback((e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    // drag up → taller (negative dy grows height)
    const next = Math.max(COMPOSER_H_MIN, Math.min(COMPOSER_H_MAX, d.startH + (d.startY - e.clientY)));
    setShellH(next);
  }, [setShellH]);
  const onResizePointerUp = useCallback(() => { dragRef.current = null; }, []);

  // Model line: compact card (selected = accent check mark, slightly illuminated when hovering)
  const modeRow = (m: ChatMode, label: string, desc: string) => {
    const active = mode === m;
    return (
      <button onClick={() => { onModeChange(m); closePop(); }}
        style={{ display: 'block', width: '100%', textAlign: 'left', background: active ? theme.panel : 'none', border: 'none', borderRadius: 3, padding: '6px 9px', cursor: 'pointer', color: theme.text }}
        onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = theme.panel; }}
        onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'none'; }}>
        <div style={{ fontSize: 12, fontWeight: 550, display: 'flex', alignItems: 'center' }}>
          {label}
          {active && <span style={{ marginLeft: 'auto', color: theme.accent, display: 'inline-flex' }}><Icon name="check" size={12} strokeWidth={2.4} /></span>}
        </div>
        <div style={{ fontSize: 10.5, color: theme.textDim, marginTop: 1, lineHeight: 1.45 }}>{desc}</div>
      </button>
    );
  };

  const refPopoverBody = (kind: 'asset' | 'template', empty: string) => {
    const list = refList(kind);
    return (
      <>
        <div style={{ fontSize: 10.5, color: theme.textDim, padding: '4px 8px 6px', letterSpacing: 0.4 }}>{kind === 'template' ? t('引用模板库') : t('引用媒体池素材')}</div>
        {list.length === 0 && <div style={{ fontSize: 12, color: theme.textDim, padding: '6px 10px' }}>{empty}</div>}
        {list.map((r) => (
          <button key={r.id} onClick={() => insert(r)}
        style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderRadius: 3, padding: '7px 10px', cursor: 'pointer', color: theme.text }}
            onMouseEnter={(e) => { e.currentTarget.style.background = theme.panel; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
            <span style={{ color: theme.textDim, lineHeight: 0 }}><Icon name={REF_ICON[r.kind]} size={15} /></span>
            <span style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
          </button>
        ))}
      </>
    );
  };

  return (
    <div
      className="cc-chat-composer"
      style={{
        position: 'relative', display: 'flex', flexDirection: 'column',
        height: shellH, minHeight: COMPOSER_H_MIN, maxHeight: COMPOSER_H_MAX,
        width: '100%', minWidth: 0, maxWidth: '100%', overflow: 'visible',
        boxSizing: 'border-box', background: theme.panelAlt,
    border: `0.5px solid ${theme.borderLight}`, borderRadius: 4,
        padding: '10px 6px 5px',
      }}
    >
      {/* top edge drag handle — pull up to expand, down to shrink */}
      <div
        className="cc-chat-composer-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label={t('拖动调整输入框高度')}
        title={t('上下拖动调整输入框高度')}
        onPointerDown={onResizePointerDown}
        onPointerMove={onResizePointerMove}
        onPointerUp={onResizePointerUp}
        onPointerCancel={onResizePointerUp}
      >
        <span className="cc-chat-composer-resize-grip" aria-hidden />
      </div>
      {selectedRefs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }} title={t('发送时以 chat_context_entry 结构化注入')}>
          {selectedRefs.map((r) => (
            <span
              key={r.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%',
                fontSize: 11, lineHeight: 1.2, padding: '2px 6px', borderRadius: 999,
                background: theme.panel, border: `0.5px solid ${theme.borderLight}`, color: theme.text,
              }}
            >
              <Icon name={REF_ICON[r.kind]} size={12} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{referenceChipText(r)}</span>
              {onRemoveRef && (
                <button
                  type="button"
                  title={t('移除引用')}
                  onClick={() => onRemoveRef(r.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: theme.textDim, padding: 0, lineHeight: 0, display: 'grid' }}
                >
                  <Icon name="x" size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {(pasting || pasteError) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontSize: 11.5 }}>
          {pasting && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: theme.accent }}>
              <Icon name="sparkles" size={12} /> {t('导入素材中…')}
            </span>
          )}
          {pasteError && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#e5866a', minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pasteError}</span>
              {onDismissPasteError && (
                <button type="button" title={t('关闭')} onClick={onDismissPasteError}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#e5866a', padding: 0, lineHeight: 0, display: 'grid', flexShrink: 0 }}>
                  <Icon name="x" size={11} />
                </button>
              )}
            </span>
          )}
        </div>
      )}
      <textarea
        ref={taRef}
        data-cc-chat-composer
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
        onPaste={(e) => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (files.length > 0 && onPasteFiles) { e.preventDefault(); onPasteFiles(files); }
        }}
        placeholder={placeholder ?? t('告诉 AI 要做哪些修改 - @ 引用素材')}
        rows={1}
        style={{
          flex: 1, width: '100%', minHeight: 28, minWidth: 0, resize: 'none',
          overflowY: 'auto', background: 'transparent', border: 'none', outline: 'none',
          color: theme.text, fontSize: 13, fontFamily: 'inherit', lineHeight: 1.45,
        }}
      />
      <ComposerToolbar
        mode={mode} activeModel={activeModel} activeSkillName={activeSkill ? skillName(activeSkill) : undefined}
        pop={pop} selecting={selecting} enhancing={enhancing} running={running}
        canEnhance={canEnhance} canSend={canSend} sendTitle={sendTitle}
        onTogglePop={toggle} onToggleSelecting={onToggleSelecting} onEnhance={onEnhance}
        onSubmit={onSubmit} onStop={onStop} />

      {/* menus rendered fixed — never clipped by composer bounds */}
      {pop === 'mode' && (
        <Popover w={172} anchor={popAnchor} onClose={closePop}>
          {modeRow('agent', t('代理模式'), t('可编辑时间线，改动可撤销'))}
          {modeRow('ask', t('问答模式'), t('只回答，不动时间线'))}
        </Popover>
      )}
      {pop === 'model' && (
        <Popover w={278} anchor={popAnchor} onClose={closePop}>
          <div style={{ fontSize: 10.5, color: theme.textDim, padding: '4px 8px 6px' }}>
            {t('本条对话使用的模型')}
          </div>
          {modelState.choices.length === 0 && (
            <div style={{ padding: '7px 9px 9px', color: theme.textDim, fontSize: 11.5, lineHeight: 1.5 }}>
              {modelState.loaded ? t('请先在设置中配置一个模型厂商。') : t('正在读取模型配置…')}
            </div>
          )}
          {modelState.choices.map((choice) => {
            const active = choice.id === modelState.activeId;
            return (
              <button
                type="button"
                key={choice.id}
                onClick={() => { selectAgentModel(choice.id); closePop(); }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 9,
                  width: '100%',
                  padding: '7px 9px',
                  border: 0,
                  borderRadius: 3,
                  background: active ? theme.panel : 'transparent',
                  color: theme.text,
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <strong style={{ display: 'block', fontSize: 11.5, fontWeight: 600 }}>
                    {choice.providerLabel}
                  </strong>
                  <small style={{ display: 'block', color: theme.textDim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {choice.model}
                  </small>
                </span>
                {active && <span style={{ color: theme.accent, lineHeight: 0 }}><Icon name="check" size={13} /></span>}
              </button>
            );
          })}
        </Popover>
      )}
      {pop === 'settings' && (
        <Popover anchor={popAnchor} onClose={closePop}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text, fontSize: 12.5 }}>
            <input type="checkbox" checked={autoApply} onChange={(e) => onAutoApplyChange(e.target.checked)} style={{ accentColor: theme.accent }} />
            {t('自动应用 AI 提案')}
          </label>
          <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 6px' }}>{t('开启后 AI 的改动直接生效，无需手动确认（仍可撤销）。')}</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text, fontSize: 12.5 }}>
            <input type="checkbox" checked={agentSettings.skillGuard} onChange={(e) => patchAgent({ skillGuard: e.target.checked })} style={{ accentColor: theme.accent }} />
            {t('Skill guard · 高成本确认')}
          </label>
          <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 6px' }}>
            {t('生成/导出等昂贵工具即使开启自动应用，仍走提案卡二次确认。')}
          </div>
          <div style={{ padding: '8px 10px 4px', color: theme.text, fontSize: 12.5 }}>{t('MG 质量')}</div>
          <div style={{ display: 'flex', gap: 4, padding: '0 10px' }}>
            {MG_TIERS.map((tier) => (
              <button key={tier} onClick={() => patchAgent({ mgTier: tier })}
                style={{ flex: 1, padding: '4px 0', fontSize: 11.5, borderRadius: 6, cursor: 'pointer', border: `0.5px solid ${agentSettings.mgTier === tier ? theme.accent : theme.borderLight}`, background: agentSettings.mgTier === tier ? theme.panel : 'none', color: agentSettings.mgTier === tier ? theme.text : theme.textDim }}>
                {t(TIER_LABELS[tier])}
              </button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: theme.textDim, padding: '4px 10px 6px' }}>
            {t('速度=最快出活 / 均衡 / 质量=打磨动效细节。')}
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text, fontSize: 12.5 }}>
            <input type="checkbox" checked={agentSettings.planMode} onChange={(e) => patchAgent({ planMode: e.target.checked })} style={{ accentColor: theme.accent }} />
            {t('计划模式')}
          </label>
          <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 10px' }}>
            {t('先出编号计划，确认后再动手。')}
          </div>
        </Popover>
      )}
      {pop === 'assets' && (
        <Popover anchor={popAnchor} onClose={closePop}>
          {refPopoverBody('asset', t('媒体池暂无素材'))}
        </Popover>
      )}
      {pop === 'skill' && (
        <Popover w={300} anchor={popAnchor} onClose={closePop}>
          <div className="cc-creative-picker-head">
            <span><Icon name="wand" size={15} /></span>
            <div>
              <strong>{t('选择创作工作流')}</strong>
              <small>{t('工作流会约束 Agent 的规划与工具调用。')}</small>
            </div>
          </div>
          <button onClick={() => { onCreativeModeChange(null); closePop(); }}
            className="cc-creative-mode-row" data-active={!creativeMode} aria-pressed={!creativeMode}>
            <span className="cc-creative-mode-icon"><Icon name="sparkles" size={15} /></span>
            <span className="cc-creative-mode-copy">
              <strong>{t('自由创作')}</strong>
              <small>{t('不限定工作流，根据当前目标灵活执行。')}</small>
            </span>
            {!creativeMode && <span className="cc-creative-mode-check"><Icon name="check" size={13} strokeWidth={2.4} /></span>}
          </button>
          <div className="cc-creative-picker-section">{t('专业工作流')}</div>
          {allCreativeSkills().map((s) => (
            <button key={s.id} onClick={() => { onCreativeModeChange(s.id); closePop(); }}
              className="cc-creative-mode-row" data-active={creativeMode === s.id}
              aria-pressed={creativeMode === s.id} title={t(s.summary)}>
              <span className="cc-creative-mode-icon"><Icon name="wand" size={15} /></span>
              <span className="cc-creative-mode-copy">
                <span className="cc-creative-mode-title">
                  <strong>{skillName(s)}</strong>
                  {!builtinIds.has(s.id) && <em>{t('自定义')}</em>}
                </span>
                <small>{t(s.summary)}</small>
              </span>
              {creativeMode === s.id && <span className="cc-creative-mode-check"><Icon name="check" size={13} strokeWidth={2.4} /></span>}
            </button>
          ))}
        </Popover>
      )}
      {pop === 'templates' && (
        <Popover anchor={popAnchor} onClose={closePop}>
          {refPopoverBody('template', t('暂无模板'))}
        </Popover>
      )}
      {pop === 'more' && (
        <Popover anchor={popAnchor} onClose={closePop}>
          <ComposerMoreMenu
            selecting={selecting} activeSkillName={activeSkill ? skillName(activeSkill) : undefined}
            canEnhance={canEnhance} enhancing={enhancing}
            onChoosePopover={setPop} onToggleSelecting={onToggleSelecting}
            onEnhance={onEnhance} onClose={closePop} />
        </Popover>
      )}
    </div>
  );
}
