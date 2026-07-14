import { useState, type ReactNode, type RefObject } from 'react';
import { theme } from '../../theme';
import type { AgentReference } from '../../agent/context';
import { Icon, type IconName } from '../icons';

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
  references: RefItem[];
  onInsertRef: (reference: RefItem) => void;
  taRef: RefObject<HTMLTextAreaElement | null>;
}

type Pop = 'mode' | 'settings' | 'assets' | 'templates' | null;

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

const REF_ICON: Record<RefItem['kind'], IconName> = { video: 'filePlay', image: 'filePlay', audio: 'fileHeadphone', template: 'sparkles' };

export function ChatComposer(props: ChatComposerProps) {
  const { value, onChange, onSubmit, onStop, onEnhance, enhancing, running, mode, onModeChange, autoApply, onAutoApplyChange, references, onInsertRef, taRef } = props;
  const [pop, setPop] = useState<Pop>(null);
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
    <div style={{ position: 'relative', background: theme.panelAlt, border: `1px solid ${theme.borderLight}`, borderRadius: 16, padding: '10px 12px 8px' }}>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit(); } }}
        placeholder="告诉 AI 要做哪些修改 - @ 引用素材"
        rows={2}
        style={{ width: '100%', resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: theme.text, fontSize: 13.5, fontFamily: 'inherit', lineHeight: 1.5, minHeight: 40 }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 2 }}>
        {/* left: mode + settings */}
        <div style={{ position: 'relative' }}>
          <BarBtn icon="sparkles" title="模式" chevron active={pop === 'mode'} onClick={() => toggle('mode')} />
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
              <div style={{ fontSize: 11, color: theme.textDim, padding: '0 10px 8px' }}>开启后 AI 的改动直接生效，无需手动确认（仍可撤销）。</div>
            </Popover>
          )}
        </div>

        <span style={{ flex: 1 }} />

        {/* right: attach / reference / enhance / send */}
        <div style={{ position: 'relative' }}>
          <BarBtn icon="paperclip" title="引用媒体池素材" active={pop === 'assets'} onClick={() => toggle('assets')} />
          {pop === 'assets' && refPopover('asset', '媒体池暂无素材')}
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
