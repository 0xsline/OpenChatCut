import { useEffect, useState, type ReactNode, type RefObject } from 'react';
import { theme } from '../../theme';
import type { AgentReference } from '../../agent/context';
import { Icon, type IconName } from '../icons';
import { CREATIVE_SKILLS, allCreativeSkills, findSkill, setCustomSkills } from '../../agent/skills-catalog';
import { loadCustomSkills } from '../../persist/skillStore';
import { loadAgentSettings, saveAgentSettings, type AgentSettings } from '../../agent/agentSettings';

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
  /** active creative-mode skill id (source agent_skill), or null = 通用 */
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
  references: RefItem[];
  onInsertRef: (reference: RefItem) => void;
  /** Structured @ refs attached to the next send (source chat_context_entry). */
  selectedRefs?: RefItem[];
  onRemoveRef?: (id: string) => void;
  /** Paste supported files (video/image/audio/gif/svg) straight into the chat. */
  onPasteFiles?: (files: File[]) => void;
  /** true while a pasted file is importing into the pool */
  pasting?: boolean;
  /** last paste import error, or null */
  pasteError?: string | null;
  onDismissPasteError?: () => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
  placeholder?: string;
}

type Pop = 'mode' | 'skill' | 'settings' | 'assets' | 'templates' | null;

// one bottom-bar icon button (source: monochrome, hover-lit)
function BarBtn({ icon, title, onClick, active, disabled, chevron }: {
  icon: IconName; title: string; onClick?: () => void; active?: boolean; disabled?: boolean; chevron?: boolean;
}) {
  return (
    <button title={title} onClick={onClick} disabled={disabled}
      style={{ background: active ? theme.panelAlt : 'none', border: 'none', cursor: disabled ? 'default' : 'pointer', padding: '5px 6px', borderRadius: 7, display: 'flex', alignItems: 'center', gap: 2, lineHeight: 0, color: disabled ? theme.textDim : active ? theme.text : theme.textDim, opacity: disabled ? 0.45 : 1 }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.color = theme.text; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = disabled ? theme.textDim : active ? theme.text : theme.textDim; }}>
      <Icon name={icon} size={17} />
      {chevron && <Icon name="chevronDown" size={12} />}
    </button>
  );
}

// a small popover anchored above the bar, with a click-away backdrop
function Popover({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
      <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 41, minWidth: 220, maxWidth: 300, maxHeight: 280, overflowY: 'auto', background: theme.panelAlt, border: `1px solid ${theme.borderLight}`, borderRadius: 12, boxShadow: '0 12px 40px rgba(0,0,0,0.5)', padding: 6 }}>
        {children}
      </div>
    </>
  );
}

const REF_ICON: Record<RefItem['kind'], IconName> = {
  video: 'filePlay', image: 'filePlay', gif: 'image', svg: 'image',
  audio: 'fileHeadphone', 'motion-graphic': 'sparkles', template: 'sparkles',
};

export function ChatComposer(props: ChatComposerProps) {
  const {
    value, onChange, onSubmit, onStop, onEnhance, enhancing, running, mode, onModeChange,
    autoApply, onAutoApplyChange, creativeMode, onCreativeModeChange, references, onInsertRef,
    selectedRefs = [], onRemoveRef, onPasteFiles, pasting, pasteError, onDismissPasteError,
    taRef, placeholder,
  } = props;
  // 水合自定义技能(source manage_skill):挂载时读 IDB → 内存注册表,bump 触发重渲染
  // 让 allCreativeSkills()/findSkill 反映自定义技能。真源是 IDB,manage_skill 工具也水合同一份。
  const [, bumpCustom] = useState(0);
  useEffect(() => {
    loadCustomSkills().then((list) => { setCustomSkills(list); bumpCustom((n) => n + 1); });
  }, []);
  const activeSkill = findSkill(creativeMode);
  const builtinIds = new Set(CREATIVE_SKILLS.map((s) => s.id));
  const [pop, setPop] = useState<Pop>(null);
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(() => loadAgentSettings());
  const patchAgent = (patch: Partial<AgentSettings>) => {
    setAgentSettings((prev) => {
      const next = { ...prev, ...patch };
      saveAgentSettings(next);
      return next;
    });
  };
  const toggle = (p: Pop) => setPop((cur) => (cur === p ? null : p));
  const canSend = !!value.trim() && !running;
  const refList = (kind: 'asset' | 'template') =>
    references.filter((r) => (kind === 'template' ? r.kind === 'template' : r.kind !== 'template'));

  const insert = (reference: RefItem) => { onInsertRef(reference); setPop(null); taRef.current?.focus(); };

  const modeRow = (m: ChatMode, label: string, desc: string) => (
    <button onClick={() => { onModeChange(m); setPop(null); }}
      style={{ display: 'block', width: '100%', textAlign: 'left', background: mode === m ? theme.panel : 'none', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text }}>
      <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>{label}{mode === m && <span style={{ color: theme.accent, fontSize: 11 }}>●</span>}</div>
      <div style={{ fontSize: 11, color: theme.textDim, marginTop: 2 }}>{desc}</div>
    </button>
  );

  const refPopover = (kind: 'asset' | 'template', empty: string) => {
    const list = refList(kind);
    return (
      <Popover onClose={() => setPop(null)}>
        <div style={{ fontSize: 10.5, color: theme.textDim, padding: '4px 8px 6px', letterSpacing: 0.4 }}>{kind === 'template' ? '引用模板库' : '引用媒体池素材'}</div>
        {list.length === 0 && <div style={{ fontSize: 12, color: theme.textDim, padding: '6px 10px' }}>{empty}</div>}
        {list.map((r) => (
          <button key={r.id} onClick={() => insert(r)}
            style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left', background: 'none', border: 'none', borderRadius: 8, padding: '7px 10px', cursor: 'pointer', color: theme.text }}
            onMouseEnter={(e) => { e.currentTarget.style.background = theme.panel; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}>
            <span style={{ color: theme.textDim, lineHeight: 0 }}><Icon name={REF_ICON[r.kind]} size={15} /></span>
            <span style={{ fontSize: 12.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
          </button>
        ))}
      </Popover>
    );
  };

  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 80, boxSizing: 'border-box', background: theme.panelAlt, border: `1px solid ${theme.borderLight}`, borderRadius: 8, padding: '6px 8px 5px' }}>
      {selectedRefs.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }} title="发送时以 chat_context_entry 结构化注入">
          {selectedRefs.map((r) => (
            <span
              key={r.id}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%',
                fontSize: 11, lineHeight: 1.2, padding: '2px 6px', borderRadius: 999,
                background: theme.panel, border: `1px solid ${theme.borderLight}`, color: theme.text,
              }}
            >
              <Icon name={REF_ICON[r.kind]} size={12} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>@{r.name}</span>
              {onRemoveRef && (
                <button
                  type="button"
                  title="移除引用"
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
              <Icon name="sparkles" size={12} /> 导入素材中…
            </span>
          )}
          {pasteError && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#e5866a', minWidth: 0 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pasteError}</span>
              {onDismissPasteError && (
                <button type="button" title="关闭" onClick={onDismissPasteError}
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
        placeholder={placeholder ?? '告诉 AI 要做哪些修改 - @ 引用素材'}
        rows={1}
        style={{ flex: 1, width: '100%', minHeight: 28, resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: theme.text, fontSize: 13, fontFamily: 'inherit', lineHeight: 1.4 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 2 }}>
        {/* left: mode + settings */}
        <div style={{ position: 'relative' }}>
          <button title="模式" onClick={() => toggle('mode')}
            style={{ height: 28, display: 'flex', alignItems: 'center', gap: 5, padding: '0 4px', border: 0, borderRadius: 6, background: pop === 'mode' ? theme.panelAlt : 'transparent', color: theme.text, cursor: 'pointer', fontSize: 12 }}>
            <Icon name="sparkles" size={15} /><span>{mode === 'agent' ? 'Agent' : 'Ask'}</span><Icon name="chevronDown" size={11} />
          </button>
          {pop === 'mode' && (
            <Popover onClose={() => setPop(null)}>
              {modeRow('agent', '代理模式', '可编辑时间线（提出可撤销的改动提案）')}
              {modeRow('ask', '问答模式', '只回答不改动时间线')}
            </Popover>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <BarBtn icon="sliders" title="设置" active={pop === 'settings'} onClick={() => toggle('settings')} />
          {pop === 'settings' && (
            <Popover onClose={() => setPop(null)}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text, fontSize: 12.5 }}>
                <input type="checkbox" checked={autoApply} onChange={(e) => onAutoApplyChange(e.target.checked)} style={{ accentColor: theme.accent }} />
                自动应用 AI 提案
              </label>
              <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 6px' }}>开启后 AI 的改动直接生效，无需手动确认（仍可撤销）。</div>

              <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text, fontSize: 12.5 }}>
                <input type="checkbox" checked={agentSettings.skillGuard} onChange={(e) => patchAgent({ skillGuard: e.target.checked })} style={{ accentColor: theme.accent }} />
                Skill guard · 高成本确认
              </label>
              <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 10px' }}>
                生成/导出等昂贵工具即使开启自动应用，仍走提案卡二次确认。
              </div>
            </Popover>
          )}
        </div>

        <span style={{ flex: 1 }} />

        {/* right: attach / reference / enhance / send */}
        <div style={{ position: 'relative' }}>
          <BarBtn icon="plus" title="引用媒体池素材" active={pop === 'assets'} onClick={() => toggle('assets')} />
          {pop === 'assets' && refPopover('asset', '媒体池暂无素材')}
        </div>
        {/* creative mode (source agent_skill) */}
        <div style={{ position: 'relative' }}>
          <BarBtn icon="palette" title={activeSkill ? `创作模式：${activeSkill.nameZh}` : '创作模式'} active={pop === 'skill' || !!activeSkill} onClick={() => toggle('skill')} />
          {pop === 'skill' && (
            <Popover onClose={() => setPop(null)}>
              <div style={{ fontSize: 10.5, color: theme.textDim, padding: '4px 8px 6px', letterSpacing: 0.4 }}>创作模式（引导 AI 的规划与流程）</div>
              <button onClick={() => { onCreativeModeChange(null); setPop(null); }}
                style={{ display: 'block', width: '100%', textAlign: 'left', background: !creativeMode ? theme.panel : 'none', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text }}>
                <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>通用{!creativeMode && <span style={{ color: theme.accent, fontSize: 11 }}>●</span>}</div>
                <div style={{ fontSize: 11, color: theme.textDim, marginTop: 2 }}>不套用特定技能，按通用剪辑助手工作。</div>
              </button>
              {allCreativeSkills().map((s) => (
                <button key={s.id} onClick={() => { onCreativeModeChange(s.id); setPop(null); }}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: creativeMode === s.id ? theme.panel : 'none', border: 'none', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', color: theme.text }}
                  onMouseEnter={(e) => { if (creativeMode !== s.id) e.currentTarget.style.background = theme.panel; }}
                  onMouseLeave={(e) => { if (creativeMode !== s.id) e.currentTarget.style.background = 'none'; }}>
                  <div style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {s.nameZh}
                    {!builtinIds.has(s.id) && <span style={{ fontSize: 9.5, color: theme.textDim, border: `1px solid ${theme.borderLight}`, borderRadius: 4, padding: '0 4px' }}>自定义</span>}
                    {creativeMode === s.id && <span style={{ color: theme.accent, fontSize: 11 }}>●</span>}
                  </div>
                  <div style={{ fontSize: 11, color: theme.textDim, marginTop: 2 }}>{s.summary}</div>
                </button>
              ))}
            </Popover>
          )}
        </div>
        <div style={{ position: 'relative' }}>
          <BarBtn icon="bookOpen" title="引用模板库" active={pop === 'templates'} onClick={() => toggle('templates')} />
          {pop === 'templates' && refPopover('template', '暂无模板')}
        </div>
        <BarBtn icon="sparkles" title={enhancing ? '增强中…' : '增强提示词'} disabled={enhancing || !value.trim() || running} onClick={onEnhance} />
        {running ? (
          <button title="停止" onClick={onStop}
            style={{ width: 30, height: 30, marginLeft: 4, borderRadius: '50%', border: 'none', background: theme.accent, cursor: 'pointer', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <span style={{ width: 10, height: 10, background: '#fff', borderRadius: 2 }} />
          </button>
        ) : (
          <button title="发送 (Enter)" onClick={onSubmit} disabled={!canSend}
            style={{ width: 30, height: 30, marginLeft: 4, borderRadius: '50%', border: 'none', background: canSend ? theme.accent : '#3a3a3a', color: '#fff', cursor: canSend ? 'pointer' : 'default', display: 'grid', placeItems: 'center', lineHeight: 0, flexShrink: 0 }}>
            <Icon name="arrowUp" size={17} strokeWidth={2.2} />
          </button>
        )}
      </div>
    </div>
  );
}
