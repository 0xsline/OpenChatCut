import { useEffect, useRef, useState } from 'react';
import { theme } from '../theme';
import type { AgentContext } from '../agent/context';
import type { TimelineState } from '../editor/types';
import { useAgent, type DisplayMessage } from '../agent/useAgent';
import { ProposalCard } from './ProposalCard';

function ToolCard({ msg }: { msg: DisplayMessage }) {
  const t = msg.tool!;
  const r = t.result as Record<string, unknown> | undefined;
  const ok = !r || !('error' in r);
  return (
    <div style={{ fontSize: 11, color: theme.textDim, borderLeft: `2px solid ${ok ? theme.trackAudioA2 : theme.accent}`, paddingLeft: 8, margin: '2px 0' }}>
      <span style={{ color: ok ? theme.trackAudioA2 : theme.accent }}>⚙ {t.name}</span>{' '}
      <code style={{ fontSize: 10 }}>{JSON.stringify(t.args)}</code>
      {r && 'error' in r && <span style={{ color: theme.accent }}> — {String(r.error)}</span>}
    </div>
  );
}

interface ChatPanelProps {
  ctx: AgentContext;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** show a proposal's draft result in the player (null = show committed state) */
  onPreviewState: (state: TimelineState | null) => void;
}

export function ChatPanel({ ctx, collapsed, onToggleCollapse, onPreviewState }: ChatPanelProps) {
  const { messages, running, send, proposal, applyProposal, rejectProposal } = useAgent(ctx);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, running, proposal]);

  // clear any preview when the proposal is resolved (applied/rejected)
  useEffect(() => {
    if (!proposal) onPreviewState(null);
  }, [proposal, onPreviewState]);

  const submit = () => {
    if (!input.trim() || running) return;
    send(input);
    setInput('');
  };

  if (collapsed) {
    return (
      <aside style={{ gridColumn: 1, gridRow: 2, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '10px 0', borderRight: `1px solid ${theme.border}`, background: theme.panel }}>
        <button onClick={onToggleCollapse} title="展开 AI" style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 14 }}>▶</button>
        <div style={{ writingMode: 'vertical-rl', color: theme.textDim, fontSize: 12, letterSpacing: 2 }}>AI</div>
      </aside>
    );
  }

  return (
    <aside style={{ gridColumn: 1, gridRow: 2, display: 'flex', flexDirection: 'column', borderRight: `1px solid ${theme.border}`, background: theme.panel, minHeight: 0, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 14px', fontSize: 12, color: theme.textDim, borderBottom: `1px solid ${theme.border}` }}>
        <span style={{ flex: 1 }}>AI</span>
        <button onClick={onToggleCollapse} title="收起 AI" style={{ background: 'none', border: 'none', color: theme.textDim, cursor: 'pointer', fontSize: 13 }}>◀</button>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: 14, fontSize: 13, color: theme.text, minHeight: 0 }}>
        {messages.length === 0 && <div style={{ color: theme.text, marginBottom: 20 }}>有什么视频剪辑需要帮忙的吗？</div>}
        {messages.map((m, i) => {
          if (m.role === 'user')
            return <div key={i} style={{ marginLeft: 'auto', maxWidth: '88%', width: 'fit-content', background: theme.panelAlt, border: `1px solid ${theme.border}`, borderRadius: 10, padding: '8px 11px', margin: '10px 0', whiteSpace: 'pre-wrap' }}>{m.text}</div>;
          if (m.role === 'assistant')
            return <div key={i} style={{ margin: '10px 0', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{m.text}</div>;
          if (m.role === 'tool') return <ToolCard key={i} msg={m} />;
          return <div key={i} style={{ color: theme.accent, fontSize: 12, margin: '6px 0' }}>⚠ {m.text}</div>;
        })}
        {running && <div style={{ color: theme.textDim, fontSize: 12, margin: '8px 0' }}>思考中…</div>}
        {proposal && (
          <ProposalCard
            proposal={proposal}
            onApply={applyProposal}
            onReject={rejectProposal}
            onPreview={(on) => onPreviewState(on ? proposal.resultState : null)}
          />
        )}
      </div>

      <div style={{ padding: 12, borderTop: `1px solid ${theme.border}` }}>
        <div style={{ background: theme.panelAlt, border: `1px solid ${theme.border}`, borderRadius: 10, padding: 10 }}>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            placeholder="告诉 AI 要做哪些修改 · @ 引用素材"
            rows={2}
            style={{ width: '100%', resize: 'none', background: 'transparent', border: 'none', outline: 'none', color: theme.text, fontSize: 13, fontFamily: 'inherit' }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: theme.textDim, fontSize: 14, marginTop: 4 }}>
            <span>✦</span><span>⚙</span><span style={{ flex: 1 }} />
            <button onClick={submit} disabled={running || !input.trim()}
              style={{ width: 28, height: 28, borderRadius: '50%', border: 'none', background: running || !input.trim() ? '#555' : theme.accent, color: '#fff', cursor: running || !input.trim() ? 'default' : 'pointer', fontSize: 14 }}>↑</button>
          </div>
        </div>
      </div>
    </aside>
  );
}
