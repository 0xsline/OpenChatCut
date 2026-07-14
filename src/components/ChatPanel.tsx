import { useEffect, useMemo, useRef, useState } from 'react';
import { theme } from '../theme';
import type { AgentContext } from '../agent/context';
import type { TimelineState } from '../editor/types';
import { useAgent } from '../agent/useAgent';
import { thinkingPhrase } from '../agent/thinkingPhrases';
import { ProposalCard } from './ProposalCard';
import { ChatMessage } from './chat/ChatMessage';
import { ChatComposer, type ChatMode, type RefItem } from './chat/ChatComposer';
import { Icon } from './icons';

const EMPTY_PROJECT_STARTERS = [
  { label: '口播剪辑', prompt: '帮我剪辑一段口播视频', icon: 'scissors' as const },
  { label: 'MG动画', prompt: '帮我制作一段 MG 动画', icon: 'film' as const },
  { label: '长视频转短视频', prompt: '把一段长视频剪成适合发布的短视频', icon: 'video' as const },
  { label: '产品 / App 宣传', prompt: '帮我制作一支产品或 App 宣传视频', icon: 'sparkles' as const },
  { label: 'AI 短片', prompt: '帮我创作一支 AI 短片', icon: 'image' as const },
  { label: '讲解视频', prompt: '帮我制作一段讲解视频', icon: 'play' as const },
];

interface ChatPanelProps {
  ctx: AgentContext;
  /** the current project's id — chat history is persisted per project (source chat_block) */
  projectId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** show a proposal's draft result in the player (null = show committed state) */
  onPreviewState: (state: TimelineState | null) => void;
  /** prefill the composer (library「用 AI 生成」); bump the number to re-seed */
  seed?: { text: string; nonce: number; reference?: RefItem } | null;
  /** active creative-mode skill id (source agent_skill), or null */
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
}

export function ChatPanel({ ctx, projectId, collapsed, onToggleCollapse, onPreviewState, seed, creativeMode, onCreativeModeChange }: ChatPanelProps) {
  const { messages, running, send, stop, enhance, proposal, applyProposal, rejectProposal, clearHistory } = useAgent(ctx, projectId);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<ChatMode>('agent');
  const [autoApply, setAutoApply] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
  const [selectedRefs, setSelectedRefs] = useState<RefItem[]>([]);
  const [feedback, setFeedback] = useState<Record<number, 'up' | 'down'>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // one film-crew "thinking…" phrase per running turn (source flavor)
  const runSeedRef = useRef(0);
  if (running && runSeedRef.current === 0) runSeedRef.current = messages.length + 1;
  if (!running) runSeedRef.current = 0;

  // @-referenceable things: media-pool assets + template library
  const references: RefItem[] = useMemo(() => {
    const assets = ctx.getDoc().assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind }));
    const tpls = ctx.templates.slice(0, 40).map((t) => ({ id: t.id, name: t.name, kind: 'template' as const }));
    return [...assets, ...tpls];
    // rebuild when the panel opens / messages change (cheap; lists are small)
  }, [ctx, messages.length]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, running, proposal]);

  // library「用 AI 生成」seeds the composer (source: attach template as chat ref)
  useEffect(() => {
    if (seed && !collapsed) {
      setInput(seed.text);
      setSelectedRefs(seed.reference ? [seed.reference] : []);
      taRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  // clear any preview when the proposal is resolved (applied/rejected)
  useEffect(() => { if (!proposal) onPreviewState(null); }, [proposal, onPreviewState]);

  // 设置·自动应用: when on, apply the proposal (all ops) as soon as it arrives
  useEffect(() => {
    if (proposal && autoApply) {
      const all = new Set(proposal.options[0].operations.map((_, i) => i));
      applyProposal(all);
    }
  }, [proposal, autoApply, applyProposal]);

  const submit = () => {
    if (!input.trim() || running) return;
    send(input, { askOnly: mode === 'ask', references: selectedRefs });
    setInput('');
    setSelectedRefs([]);
  };
  const runEnhance = async () => {
    if (!input.trim() || enhancing || running) return;
    setEnhancing(true);
    try { const improved = await enhance(input); setInput(improved); taRef.current?.focus(); }
    finally { setEnhancing(false); }
  };
  const insertRef = (reference: RefItem) => {
    setSelectedRefs((current) => current.some((item) => item.id === reference.id) ? current : [...current, reference]);
    setInput((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@${reference.name} `);
  };

  if (collapsed) {
    return (
      <aside style={{ gridColumn: 1, gridRow: '2 / 5', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '10px 0', borderRight: `1px solid ${theme.border}`, background: theme.panel }}>
        <button onClick={onToggleCollapse} title="展开 AI" style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 14 }}><span style={{ transform: 'rotate(-90deg)', display: 'inline-flex' }}><Icon name="chevronDown" size={14} /></span></button>
        <div style={{ writingMode: 'vertical-rl', color: theme.textDim, fontSize: 12, letterSpacing: 2 }}>AI</div>
      </aside>
    );
  }

  return (
    <aside style={{ gridColumn: 1, gridRow: '2 / 5', display: 'flex', flexDirection: 'column', borderRight: `1px solid ${theme.border}`, background: theme.panel, minHeight: 0, minWidth: 0 }}>
      {/* header: AI · clear · collapse */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ flex: 1, fontSize: 13, color: theme.text, fontWeight: 600 }}>AI</span>
        {messages.length > 0 && (
          <button onClick={clearHistory} disabled={running} title="清空对话"
            style={{ background: 'none', border: 'none', color: theme.textDim, cursor: running ? 'default' : 'pointer', opacity: running ? 0.4 : 1, padding: 2, lineHeight: 0 }}>
            <Icon name="trash" size={14} />
          </button>
        )}
        <button onClick={onToggleCollapse} title="收起 AI" style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 13 }}><span style={{ transform: 'rotate(90deg)', display: 'inline-flex' }}><Icon name="chevronDown" size={14} /></span></button>
      </div>

      {/* messages */}
      <div ref={scrollRef} className={`cc-chat-messages${messages.length === 0 ? ' empty' : ''}`}>
        {messages.length === 0 && (
          <div className="cc-chat-onboarding">
            <h2>今天想创作什么？</h2>
            <div className="cc-chat-starter-grid">
              {EMPTY_PROJECT_STARTERS.map((starter) => (
                <button key={starter.label} onClick={() => { setInput(starter.prompt); requestAnimationFrame(() => taRef.current?.focus()); }}>
                  <span><Icon name={starter.icon} size={17} /></span>
                  {starter.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <ChatMessage key={i} msg={m}
            streaming={running && i === messages.length - 1 && m.role === 'assistant'}
            feedback={feedback[i] ?? null}
            onFeedback={(v) => setFeedback((f) => {
              const next = { ...f };
              if (next[i] === v) delete next[i]; else next[i] = v;
              return next;
            })}
            onWidgetSubmit={(answer) => { if (!running) send(answer, { askOnly: mode === 'ask' }); }} />
        ))}
        {running && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: theme.textDim, fontSize: 12.5, margin: '10px 0' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: theme.accent, animation: 'cc-rec-pulse 1.2s ease-out infinite', flexShrink: 0 }} />
            {thinkingPhrase(runSeedRef.current)}…
          </div>
        )}
        {proposal && !autoApply && (
          <ProposalCard proposal={proposal} onApply={applyProposal} onReject={rejectProposal}
            onPreview={(on) => onPreviewState(on ? proposal.resultState : null)} />
        )}
      </div>

      {/* composer */}
      <div style={{ padding: '12px 15px 12px 16px', borderTop: `1px solid ${theme.border}` }}>
        <ChatComposer
          value={input} onChange={(value) => {
            setInput(value);
            setSelectedRefs((current) => current.filter((reference) => value.includes(`@${reference.name}`)));
          }} onSubmit={submit} onStop={stop}
          onEnhance={runEnhance} enhancing={enhancing} running={running}
          mode={mode} onModeChange={setMode}
          autoApply={autoApply} onAutoApplyChange={setAutoApply}
          creativeMode={creativeMode} onCreativeModeChange={onCreativeModeChange}
          references={references} onInsertRef={insertRef} taRef={taRef}
          placeholder={messages.length === 0 ? '描述你想要创建的内容...' : '告诉 AI 要做哪些修改 - @ 引用素材'} />
      </div>
    </aside>
  );
}
