import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { theme, themeAlpha } from '../../theme';
import { getLocale, useT } from '../../i18n/locale';
import type { AgentReference } from '../../agent/context';
import { isSelectionRefKind } from '../../agent/selection-refs';
import { Icon, type IconName } from '../icons';
import { CREATIVE_SKILLS, allCreativeSkills, findSkill, setCustomSkills } from '../../agent/skills/skills-catalog';
import { loadCustomSkills } from '../../persist/skillStore';
import { loadAgentSettings, saveAgentSettings, MG_TIERS, type AgentSettings, type MgTier } from '../../agent/settings/agentSettings';
import { usePersistedState } from '../../hooks/usePersistedState';
import {
  getAgentModelSnapshot,
  selectAgentModel,
  subscribeAgentModels,
} from '../../agent/model-selection';

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
  /** 选择模式: pick clips / canvas regions / transcript
   * spans / ruler times as structured references for the next message. */
  selecting: boolean;
  onToggleSelecting: () => void;
  /** active creative-mode skill id (agent_skill), or null = 通用 */
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
  references: RefItem[];
  onInsertRef: (reference: RefItem) => void;
  /** Structured @ refs attached to the next send (chat_context_entry). */
  selectedRefs?: RefItem[];
  onRemoveRef?: (id: string) => void;
  /** Paste supported files (video/image/audio/gif/svg) straight into the chat.
   * 语义:粘到聊天框的文件先导入媒体池,再自动附成 @ref(不直接上时间线)。 */
  onPasteFiles?: (files: File[]) => void;
  /** true while a pasted file is importing into the pool */
  pasting?: boolean;
  /** last paste import error, or null */
  pasteError?: string | null;
  onDismissPasteError?: () => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}

type Pop = 'mode' | 'model' | 'skill' | 'settings' | 'assets' | 'templates' | null;

// one bottom-bar icon button (monochrome, hover-lit)
function BarBtn({ icon, title, onClick, active, disabled, chevron }: {
  icon: IconName; title: string;
  onClick?: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  active?: boolean; disabled?: boolean; chevron?: boolean;
}) {
  return (
    <button type="button" title={title} onClick={onClick} disabled={disabled}
      style={{ background: active ? theme.panelAlt : 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: '4px 5px', borderRadius: 4, display: 'flex', alignItems: 'center', gap: 2, lineHeight: 0, color: disabled ? theme.textDim : active ? theme.text : theme.textDim, opacity: disabled ? 0.45 : 1, flexShrink: 0 }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = theme.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = disabled ? theme.textDim : active ? theme.text : theme.textDim; }}>
      <Icon name={icon} size={16} />
      {chevron && <Icon name="chevronDown" size={12} />}
    </button>
  );
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

// MG 质量三档标签 (speed|balance|quality)
const TIER_LABELS: Record<MgTier, string> = { speed: '速度', balance: '均衡', quality: '质量' };

const REF_ICON: Record<RefItem['kind'], IconName> = {
  video: 'filePlay', image: 'filePlay', gif: 'image', svg: 'image',
  audio: 'fileHeadphone', 'motion-graphic': 'sparkles', template: 'sparkles',
  // selection-mode picks (item / time / region / transcript references)
  item: 'film', timepoint: 'clock', timerange: 'clock',
  'canvas-region': 'aspect', 'transcript-selection': 'text',
};

export function ChatComposer(props: ChatComposerProps) {
  const t = useT();
  // 技能目录自带官方英文 name,英文态直接用,不进词典重复;summary 只有中文,走 t()。
  const skillName = (s: { name: string; nameZh: string }): string =>
    (getLocale() === 'en' ? s.name : s.nameZh);
  const {
    value, onChange, onSubmit, onStop, onEnhance, enhancing, running, mode, onModeChange,
    autoApply, onAutoApplyChange, selecting, onToggleSelecting,
    creativeMode, onCreativeModeChange, references, onInsertRef,
    selectedRefs = [], onRemoveRef, onPasteFiles, pasting, pasteError, onDismissPasteError,
    taRef, placeholder,
  } = props;
  // 水合自定义技能(manage_skill):挂载时读 IDB → 内存注册表,bump 触发重渲染
  // 让 allCreativeSkills()/findSkill 反映自定义技能。真源是 IDB,manage_skill 工具也水合同一份。
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
  const [pop, setPop] = useState<Pop>(null);
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
  const toggle = (p: Pop, el?: EventTarget | null) => {
    const node = el instanceof HTMLElement ? el : null;
    setPop((cur) => {
      if (cur === p) { setPopAnchor(null); return null; }
      setPopAnchor(node);
      return p;
    });
  };
  const canSend = !!value.trim() && !running;
  const refList = (kind: 'asset' | 'template') =>
    references.filter((r) => (kind === 'template' ? r.kind === 'template' : r.kind !== 'template'));

  const insert = (reference: RefItem) => { onInsertRef(reference); closePop(); taRef.current?.focus(); };

  // 上下拖动改输入区高度:顶边把手 + localStorage 记忆
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

  // 模式行:紧凑小卡(选中 = accent 对勾,悬停微亮)
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
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{isSelectionRefKind(r.kind) ? r.name : `@${r.name}`}</span>
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
      <div className="cc-chat-composer-bar">
        <div className="cc-chat-composer-bar-tools">
          <button title={t('模式')} onClick={(e) => toggle('mode', e.currentTarget)}
            className="cc-chat-mode-btn"
            style={{ height: 28, display: 'flex', alignItems: 'center', gap: 3, padding: '0 3px', border: 0, borderRadius: 6, background: pop === 'mode' ? theme.panelAlt : 'transparent', color: theme.text, cursor: 'pointer', fontSize: 12, flexShrink: 0 }}>
            <Icon name="sparkles" size={15} /><span className="cc-chat-mode-label">{mode === 'agent' ? 'Agent' : 'Ask'}</span><Icon name="chevronDown" size={11} />
          </button>
          <button
            type="button"
            title={activeModel
              ? t('当前模型：{name}', { name: `${activeModel.providerLabel} · ${activeModel.model}` })
              : t('选择模型')}
            onClick={(event) => toggle('model', event.currentTarget)}
            style={{
              height: 28,
              minWidth: 0,
              maxWidth: 132,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '0 6px',
              border: 0,
              borderRadius: 4,
              background: pop === 'model' ? theme.panel : 'transparent',
              color: activeModel ? theme.textDim : theme.textDim,
              cursor: 'pointer',
              fontSize: 11,
              flexShrink: 1,
            }}
          >
            <Icon name="cloud" size={13} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {activeModel?.model ?? t('模型')}
            </span>
            <Icon name="chevronDown" size={10} />
          </button>
          <BarBtn icon="sliders" title={t('设置')} active={pop === 'settings'} onClick={(e) => toggle('settings', e.currentTarget)} />
          <BarBtn icon="cursor" title={t('选择模式：点片段 / 拖画布 / 选文字稿作为引用')} active={selecting} onClick={onToggleSelecting} />
          <BarBtn icon="plus" title={t('引用媒体池素材')} active={pop === 'assets'} onClick={(e) => toggle('assets', e.currentTarget)} />
          <BarBtn icon="wand" title={activeSkill ? t('创作模式：{name}', { name: skillName(activeSkill) }) : t('创作模式')} active={pop === 'skill' || !!activeSkill} onClick={(e) => toggle('skill', e.currentTarget)} />
          <BarBtn icon="bookOpen" title={t('引用模板库')} active={pop === 'templates'} onClick={(e) => toggle('templates', e.currentTarget)} />
          <BarBtn icon="sparkles" title={enhancing ? t('增强中…') : t('增强提示词')} disabled={enhancing || !value.trim() || running} onClick={onEnhance} />
        </div>
        {running ? (
          <button title={t('停止')} onClick={onStop} className="cc-chat-send-btn"
            style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: theme.accent, cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <span style={{ width: 10, height: 10, background: theme.onAccent, borderRadius: 2 }} />
          </button>
        ) : (
          <button title={t('发送 (Enter)')} onClick={onSubmit} disabled={!canSend} className="cc-chat-send-btn"
            style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: canSend ? theme.accent : theme.border, color: canSend ? theme.onAccent : theme.textDim, cursor: canSend ? 'pointer' : 'default', display: 'grid', placeItems: 'center', lineHeight: 0, flexShrink: 0 }}>
            <Icon name="arrowUp" size={16} strokeWidth={2.2} />
          </button>
        )}
      </div>

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
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text, fontSize: 12.5 }}>
            <input type="checkbox" checked={agentSettings.thinkingEnabled} onChange={(e) => patchAgent({ thinkingEnabled: e.target.checked })} style={{ accentColor: theme.accent }} />
            {t('思考模式')}
          </label>
          <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 6px' }}>
            {t('回答前先展开思考过程；中转不支持时本轮自动关闭。')}
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
    </div>
  );
}
