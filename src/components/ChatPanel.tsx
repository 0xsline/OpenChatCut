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

interface ChatPanelProps {
  ctx: AgentContext;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** show a proposal's draft result in the player (null = show committed state) */
  onPreviewState: (state: TimelineState | null) => void;
  /** prefill the composer (library「用 AI 生成」); bump the number to re-seed */
  seed?: { text: string; nonce: number } | null;
}

export function ChatPanel({ ctx, collapsed, onToggleCollapse, onPreviewState, seed }: ChatPanelProps) {
  const { messages, running, send, stop, enhance, proposal, applyProposal, rejectProposal } = useAgent(ctx);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<ChatMode>('agent');
  const [autoApply, setAutoApply] = useState(false);
  const [enhancing, setEnhancing] = useState(false);
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
    if (seed && !collapsed) { setInput(seed.text); taRef.current?.focus(); }
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
    send(input, { askOnly: mode === 'ask' });
    setInput('');
  };
  const runEnhance = async () => {
    if (!input.trim() || enhancing || running) return;
    setEnhancing(true);
    try { const improved = await enhance(input); setInput(improved); taRef.current?.focus(); }
    finally { setEnhancing(false); }
  };
  const insertRef = (name: string) => {
    setInput((v) => `${v}${v && !v.endsWith(' ') ? ' ' : ''}@${name} `);
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
      {/* header: AI · collapse */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ flex: 1, fontSize: 13, color: theme.text, fontWeight: 600 }}>AI</span>
        <button onClick={onToggleCollapse} title="收起 AI" style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 13 }}><span style={{ transform: 'rotate(90deg)', display: 'inline-flex' }}><Icon name="chevronDown" size={14} /></span></button>
      </div>

      {/* messages */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '4px 14px', fontSize: 13.5, color: theme.text, minHeight: 0 }}>
        {messages.length === 0 && <div style={{ color: theme.text, margin: '18px 0' }}>有什么视频剪辑需要帮忙的吗？</div>}
        {messages.map((m, i) => (
          <ChatMessage key={i} msg={m}
            streaming={running && i === messages.length - 1 && m.role === 'assistant'}
            feedback={feedback[i] ?? null}
            onFeedback={(v) => setFeedback((f) => {
              const next = { ...f };
              if (next[i] === v) delete next[i]; else next[i] = v;
              return next;
            })} />
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
      <div style={{ padding: 12, borderTop: `1px solid ${theme.border}` }}>
        <ChatComposer
          value={input} onChange={setInput} onSubmit={submit} onStop={stop}
          onEnhance={runEnhance} enhancing={enhancing} running={running}
          mode={mode} onModeChange={setMode}
          autoApply={autoApply} onAutoApplyChange={setAutoApply}
          references={references} onInsertRef={insertRef} taRef={taRef} />
      </div>
    </aside>
  );
}
