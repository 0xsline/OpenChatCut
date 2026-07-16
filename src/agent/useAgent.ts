import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveAgentReferences, type AgentContext, type AgentReference } from './context';
import { initialMessages, runAgent, type LLMMessage } from './runtime';
import { anthropic, MODEL } from './client';
import { makeDraft, replayActions } from '../editor/store';
import { buildOperation, buildProposal, isProposalStale, partitionProposalActions, type Operation, type Proposal } from './proposal';
import { loadChat, saveChat, clearChat } from '../persist/projectStore';

export interface DisplayMessage {
  role: 'user' | 'assistant' | 'tool' | 'error';
  text: string;
  /** 推理流(原生 thinking_delta 或内联 <thinking> 抽取),渲染为折叠的「思考过程」块 */
  thinking?: string;
  tool?: { name: string; args: unknown; result: unknown };
}

export function useAgent(ctx: AgentContext, projectId: string) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [running, setRunning] = useState(false);
  // true once this project's saved chat has been loaded — consumers that want to act
  // "only on a genuinely empty chat" (e.g. scenario-preset composer seeding) gate on it
  const [hydrated, setHydrated] = useState(false);
  // pending edit proposal awaiting the user's apply/reject (source: edit-proposal)
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const llmRef = useRef<LLMMessage[]>(initialMessages());
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx; // always use the latest editor context
  // gate persistence until the project's saved chat has been hydrated, so the
  // empty initial state can't clobber it (source chat_block: ordered per-project)
  const hydratedRef = useRef(false);
  const proposalRef = useRef<Proposal | null>(null);
  proposalRef.current = proposal;
  // in-flight turn's abort controller (source: Stop button while running)
  const abortRef = useRef<AbortController | null>(null);

  // hydrate this project's saved chat on mount / project switch (source chat_block)
  useEffect(() => {
    let alive = true;
    hydratedRef.current = false;
    setHydrated(false);
    setProposal(null);
    loadChat(projectId).then((saved) => {
      if (!alive) return;
      setMessages(saved ? (saved.messages as DisplayMessage[]) : []);
      llmRef.current = saved ? (saved.llm as LLMMessage[]) : initialMessages();
      hydratedRef.current = true;
      setHydrated(true);
    });
    return () => { alive = false; };
  }, [projectId]);

  // persist on turn / proposal boundaries — never mid-stream (running) so IDB
  // isn't hammered per token; `proposal` dep captures apply/reject (they push to llmRef).
  useEffect(() => {
    if (!hydratedRef.current || running) return;
    void saveChat(projectId, { messages, llm: llmRef.current });
  }, [messages, running, proposal, projectId]);

  const send = useCallback(
    async (text: string, opts?: { askOnly?: boolean; references?: AgentReference[] }) => {
      const trimmed = text.trim();
      if (!trimmed || running || proposal) return; // resolve a pending proposal first
      setMessages((m) => [...m, { role: 'user', text: trimmed }]);
      const contextEntries = resolveAgentReferences(ctxRef.current, opts?.references ?? []);
      const content = contextEntries.length
        ? `${trimmed}\n\n${JSON.stringify({ type: 'chat_context_entry', entries: contextEntries })}`
        : trimmed;
      llmRef.current.push({ role: 'user', content });
      setRunning(true);
      // Faithful propose→apply: run the agent's tools against a DRAFT copy of the
      // PROJECT (so it sees its own pending edits, incl. timeline switches)
      // without touching the real store; capture each mutating tool call as an operation.
      const baseDoc = ctxRef.current.getDoc();
      const draft = makeDraft(baseDoc);
      const draftCtx: AgentContext = {
        commands: draft.commands,
        getState: draft.getState,
        getDoc: draft.getDoc,
        getCreativeMode: ctxRef.current.getCreativeMode,
        templates: ctxRef.current.templates,
        audio: ctxRef.current.audio,
        getProjectId: ctxRef.current.getProjectId,
        openProject: ctxRef.current.openProject,
        onProjectRenamed: ctxRef.current.onProjectRenamed,
      };
      const ops: Operation[] = [];
      let proposalBaseDoc = baseDoc;
      let draftInvalidated = false;
      let assistantText = '';
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        llmRef.current = await runAgent(llmRef.current, draftCtx, (ev) => {
          if (ev.type === 'text-start') {
            setMessages((m) => {
              const last = m[m.length - 1];
              // thinking 增量可能已开了本轮的助手气泡(只有思考没正文)→ 复用,不再另起一条
              if (last?.role === 'assistant' && last.text === '' && last.thinking) return m;
              return [...m, { role: 'assistant', text: '' }];
            });
          } else if (ev.type === 'thinking-delta') {
            setMessages((m) => {
              const last = m[m.length - 1];
              if (last?.role === 'assistant') return [...m.slice(0, -1), { ...last, thinking: (last.thinking ?? '') + ev.delta }];
              return [...m, { role: 'assistant', text: '', thinking: ev.delta }];
            });
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
            const { persistent, proposed } = partitionProposalActions(actions);
            if (persistent.length) {
              const observed = ctxRef.current.getDoc();
              if (observed !== baseDoc && observed !== proposalBaseDoc) {
                draftInvalidated = true;
                proposalBaseDoc = observed;
              }
              proposalBaseDoc = replayActions(proposalBaseDoc, persistent);
              ctxRef.current.commands.applyDoc(proposalBaseDoc);
            }
            if (proposed.length) ops.push(buildOperation(ev.name, (ev.args ?? {}) as Record<string, unknown>, proposed));
          } else {
            setMessages((m) => [...m, { role: 'error', text: ev.message }]);
          }
        }, { askOnly: opts?.askOnly, signal: ac.signal });
        if (!ac.signal.aborted && ops.length) {
          if (draftInvalidated) setMessages((m) => [...m, { role: 'error', text: '生成期间工程发生了其他修改；素材已保存到媒体池，请重新发送落轨请求。' }]);
          else setProposal(buildProposal(ops, assistantText, proposalBaseDoc, draft.getState()));
        }
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

  // Apply the selected operations atomically (one undo step). A proposal is
  // rejected if the project changed after it was generated: replaying index- or
  // timeline-sensitive actions onto a different snapshot can silently edit the
  // wrong clip. Side effects stay outside React state updaters.
  const applyProposal = useCallback((selected: Set<number>) => {
    const p = proposalRef.current;
    if (!p) return;
    const currentDoc = ctxRef.current.getDoc();
    if (isProposalStale(p, currentDoc)) {
      setMessages((m) => [...m, { role: 'error', text: '工程已在提案生成后发生变化，请重新发送请求。' }]);
      setProposal(null);
      return;
    }
    const chosen = p.options[0].operations.filter((_, i) => selected.has(i));
    const result = replayActions(currentDoc, chosen.flatMap((o) => o.actions));
    ctxRef.current.commands.applyDoc(result);
    llmRef.current.push({ role: 'user', content: `（已应用提案：${chosen.length}/${p.options[0].operations.length} 项操作。）` });
    setProposal(null);
  }, []);

  const rejectProposal = useCallback(() => {
    if (!proposalRef.current) return;
    llmRef.current.push({ role: 'user', content: '（用户拒绝了上述提案，未应用任何改动。）' });
    setProposal(null);
  }, []);

  // 清空对话 (source clearHistory): drop the rendered rows + the LLM history +
  // the persisted copy, so a fresh conversation starts (does NOT touch the timeline).
  const clearHistory = useCallback(() => {
    if (running) return;
    llmRef.current = initialMessages();
    setProposal(null);
    setMessages([]);
    void clearChat(projectId);
  }, [running, projectId]);

  return { messages, running, hydrated, send, stop, enhance, proposal, applyProposal, rejectProposal, clearHistory };
}
