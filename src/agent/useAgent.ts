import { useCallback, useRef, useState } from 'react';
import type { AgentContext } from './context';
import { initialMessages, runAgent, type LLMMessage } from './runtime';
import { anthropic, MODEL } from './client';
import { makeDraft, replayActions } from '../editor/store';
import { activeTimeline } from '../editor/types';
import { buildOperation, buildProposal, type Operation, type Proposal } from './proposal';

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  tool?: { name: string; args: unknown; result: unknown };
}

export function useAgent(ctx: AgentContext) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [running, setRunning] = useState(false);
  // pending edit proposal awaiting the user's apply/reject (source: edit-proposal)
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const llmRef = useRef<LLMMessage[]>(initialMessages());
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx; // always use the latest editor context
  const proposalRef = useRef<Proposal | null>(null);
  proposalRef.current = proposal;
  // in-flight turn's abort controller (source: Stop button while running)
  const abortRef = useRef<AbortController | null>(null);

  const send = useCallback(
    async (text: string, opts?: { askOnly?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed || running || proposal) return; // resolve a pending proposal first
      setMessages((m) => [...m, { role: 'user', text: trimmed }]);
      llmRef.current.push({ role: 'user', content: trimmed });
      setRunning(true);
      // Faithful propose→apply: run the agent's tools against a DRAFT copy of the
      // PROJECT (so it sees its own pending edits, incl. timeline switches)
      // without touching the real store; capture each mutating tool call as an operation.
      const baseDoc = ctxRef.current.getDoc();
      const draft = makeDraft(baseDoc);
      const draftCtx: AgentContext = { commands: draft.commands, getState: draft.getState, getDoc: draft.getDoc, templates: ctxRef.current.templates, audio: ctxRef.current.audio };
      const ops: Operation[] = [];
      let assistantText = '';
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        llmRef.current = await runAgent(llmRef.current, draftCtx, (ev) => {
          if (ev.type === 'text-start') {
            setMessages((m) => [...m, { role: 'assistant', text: '' }]);
          } else if (ev.type === 'text-delta') {
            assistantText += ev.delta;
            setMessages((m) => {
              const last = m[m.length - 1];
              if (last?.role === 'assistant') return [...m.slice(0, -1), { ...last, text: last.text + ev.delta }];
              return [...m, { role: 'assistant', text: ev.delta }];
            });
          } else if (ev.type === 'tool') {
            setMessages((m) => [...m, { role: 'tool', text: '', tool: { name: ev.name, args: ev.args, result: ev.result } }]);
            const actions = draft.takeActions(); // actions this tool produced (empty for read-only tools)
            if (actions.length) ops.push(buildOperation(ev.name, (ev.args ?? {}) as Record<string, unknown>, actions));
          } else {
            setMessages((m) => [...m, { role: 'error', text: ev.message }]);
          }
        }, { askOnly: opts?.askOnly, signal: ac.signal });
        if (!ac.signal.aborted && ops.length) setProposal(buildProposal(ops, assistantText, activeTimeline(baseDoc), draft.getState()));
      } finally {
        abortRef.current = null;
        setRunning(false);
      }
    },
    [running, proposal],
  );

  // Stop the in-flight turn (source: send button ↔ stop while running)
  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  // 增强提示词(source ✨ wand): one-shot LLM rewrite of the composer draft into a
  // clearer, executable editing instruction. No tools, no state change; returns
  // the improved text (or the original on any failure).
  const enhance = useCallback(async (draft: string): Promise<string> => {
    const t = draft.trim();
    if (!t) return draft;
    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: '你是视频剪辑助手的提示词增强器。把用户潦草或口语化的剪辑意图，改写成一句清晰、具体、可直接执行的中文剪辑指令。只输出改写后的指令本身，不要解释、不要加引号、不要换行。',
        messages: [{ role: 'user', content: t }],
      });
      const out = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('').trim();
      return out || draft;
    } catch {
      return draft;
    }
  }, []);

  // apply the selected operations atomically (one undo step), replaying on the
  // CURRENT project so it composes with any manual edits made meanwhile. Side
  // effects live OUTSIDE the state updater (a setState updater must be pure —
  // React double-invokes it in dev, which would double-commit).
  const applyProposal = useCallback((selected: Set<number>) => {
    const p = proposalRef.current;
    if (!p) return;
    const chosen = p.options[0].operations.filter((_, i) => selected.has(i));
    const result = replayActions(ctxRef.current.getDoc(), chosen.flatMap((o) => o.actions));
    ctxRef.current.commands.applyDoc(result);
    llmRef.current.push({ role: 'user', content: `（已应用提案：${chosen.length}/${p.options[0].operations.length} 项操作。）` });
    setProposal(null);
  }, []);

  const rejectProposal = useCallback(() => {
    if (!proposalRef.current) return;
    llmRef.current.push({ role: 'user', content: '（用户拒绝了上述提案，未应用任何改动。）' });
    setProposal(null);
  }, []);

  return { messages, running, send, stop, enhance, proposal, applyProposal, rejectProposal };
}
