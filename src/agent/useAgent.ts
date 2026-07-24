import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveAgentReferences, type AgentContext, type AgentReference } from './context';
import { initialMessages, runAgent, type LLMMessage } from './runtime';
import {
  generateAgentText,
  normalizeLlmProvider,
  PROVIDER,
  type LlmProvider,
} from './client';
import { normalizeLlmMessages, prepareMessagesForProvider } from './messages';
import { makeDraft, replayActions } from '../editor/store';
import { buildOperation, buildProposal, isProposalStale, partitionProposalActions, type Operation, type Proposal } from './proposal';
import { isSkillAllowed, rememberSkillAllowed, type GuardDecision } from './skills/skillGuard';
import type { GenerationGuardSkill } from './settings/agentSettings';
import { loadChat, saveChat, clearChat } from '../persist/projectStore';
import { loadProposal, saveProposal, clearProposal } from '../persist/proposalStore';

export interface DisplayMessage {
  // 'continue' = maxTurns Pause card (click "Continue" to continue running; persistent, can continue after refreshing)
  role: 'user' | 'assistant' | 'tool' | 'error' | 'continue';
  text: string;
  /** reasoning flow(Native thinking_delta or inline <thinking> extract),Rendered as a collapsed "thought process" block */
  thinking?: string;
  tool?: { name: string; args: unknown; result: unknown };
}

/** prefix skill_guard pending requests(Rendered as a card waiting for user confirmation)。 */
export interface PendingGuard {
  skill: GenerationGuardSkill;
  tool: string;
  resolve: (d: GuardDecision) => void;
}

/** Live lines in tool parameter streaming compose(temporary state,Not persistent)。 */
export interface LiveTool {
  name: string;
  partial: string;
}

export function useAgent(ctx: AgentContext, projectId: string) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [running, setRunning] = useState(false);
  // true once this project's saved chat has been loaded — consumers that want to act
  // "only on a genuinely empty chat" (e.g. scenario-preset composer seeding) gate on it
  const [hydrated, setHydrated] = useState(false);
  // pending edit proposal awaiting the user's apply/reject
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // Proposal expired banner (three choices: still apply / re-propose / cancel)
  const [proposalStale, setProposalStale] = useState(false);
  // Pre-skill_guard pending card + tool parameter real-time stream (all temporary)
  const [pendingGuard, setPendingGuard] = useState<PendingGuard | null>(null);
  const [liveTool, setLiveTool] = useState<LiveTool | null>(null);
  const pendingGuardRef = useRef<PendingGuard | null>(null);
  pendingGuardRef.current = pendingGuard;
  const llmRef = useRef<LLMMessage[]>(initialMessages());
  const llmProviderRef = useRef<LlmProvider>(PROVIDER);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx; // always use the latest editor context
  // gate persistence until the project's saved chat has been hydrated, so the
  // empty initial state can't clobber it (chat is persisted ordered per-project)
  const hydratedRef = useRef(false);
  const proposalRef = useRef<Proposal | null>(null);
  proposalRef.current = proposal;
  // in-flight turn's abort controller (aborted by the Stop button)
  const abortRef = useRef<AbortController | null>(null);

  // hydrate chat + pending proposal on mount / project switch
  useEffect(() => {
    let alive = true;
    hydratedRef.current = false;
    setHydrated(false);
    setProposal(null);
    setProposalStale(false);
    void (async () => {
      const [saved, pending] = await Promise.all([loadChat(projectId), loadProposal(projectId)]);
      if (!alive) return;
      setMessages(saved ? (saved.messages as DisplayMessage[]) : []);
      if (saved) {
        const sourceProvider = normalizeLlmProvider(saved.llmProvider ?? 'anthropic');
        llmRef.current = prepareMessagesForProvider(
          normalizeLlmMessages(saved.llm),
          sourceProvider,
          PROVIDER,
        );
      } else {
        llmRef.current = initialMessages();
      }
      llmProviderRef.current = PROVIDER;
      // Drop stale proposals (user edited the project after the snapshot, or
      // corrupt/partial IDB). Clear disk so we don't re-offer a dead card.
      if (pending && !isProposalStale(pending, ctxRef.current.getDoc())) {
        setProposal(pending);
      } else if (pending) {
        void clearProposal(projectId);
      }
      hydratedRef.current = true;
      setHydrated(true);
    })();
    return () => { alive = false; };
  }, [projectId]);

  // persist on turn / proposal boundaries — never mid-stream (running) so IDB
  // isn't hammered per token; `proposal` dep captures apply/reject (they push to llmRef).
  useEffect(() => {
    if (!hydratedRef.current || running) return;
    void saveChat(projectId, {
      messages,
      llm: llmRef.current,
      llmFormat: 'ai-sdk-v1',
      llmProvider: llmProviderRef.current,
    });
    if (proposal) void saveProposal(projectId, proposal);
    else void clearProposal(projectId);
  }, [messages, running, proposal, projectId]);

  const send = useCallback(
    async (text: string, opts?: { askOnly?: boolean; references?: AgentReference[] }) => {
      const trimmed = text.trim();
      if (!trimmed || running || proposalRef.current) return; // resolve a pending proposal first
      setMessages((m) => [...m, { role: 'user', text: trimmed }]);
      const contextEntries = resolveAgentReferences(ctxRef.current, opts?.references ?? []);
      const content = contextEntries.length
        ? `${trimmed}\n\n${JSON.stringify({ type: 'chat_context_entry', entries: contextEntries })}`
        : trimmed;
      if (llmProviderRef.current !== PROVIDER) {
        llmRef.current = prepareMessagesForProvider(
          llmRef.current,
          llmProviderRef.current,
          PROVIDER,
        );
        llmProviderRef.current = PROVIDER;
      }
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
        setCreativeMode: ctxRef.current.setCreativeMode,
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
              // The thinking increment may have opened the current round of assistant bubbles (only thinking without text) → reuse, no longer create a new one
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
          } else if (ev.type === 'tool-input-start') {
            setLiveTool({ name: ev.name, partial: '' });
          } else if (ev.type === 'tool-input-delta') {
            setLiveTool((lt) => (lt ? { ...lt, partial: lt.partial + ev.delta } : lt));
          } else if (ev.type === 'tool') {
            setLiveTool(null);
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
          } else if (ev.type === 'max-turns') {
            setMessages((m) => [...m, { role: 'continue', text: String(ev.turns) }]);
          } else {
            setMessages((m) => [...m, { role: 'error', text: ev.message }]);
          }
        }, {
          askOnly: opts?.askOnly,
          signal: ac.signal,
          // Pre-skill_guard: Authorization has been remembered and released directly; otherwise, the pending card will be hung up to wait for the user.
          onSkillGuard: ({ skill, tool }) => {
            if (isSkillAllowed(skill, projectId)) return Promise.resolve<GuardDecision>('allow-once');
            return new Promise<GuardDecision>((resolve) => {
              setPendingGuard({
                skill,
                tool,
                resolve: (d) => {
                  setPendingGuard(null);
                  if (d === 'allow-scope') rememberSkillAllowed(skill, projectId);
                  resolve(d);
                },
              });
            });
          },
        });
        llmProviderRef.current = PROVIDER;
        if (!ac.signal.aborted && ops.length) {
          if (draftInvalidated) setMessages((m) => [...m, { role: 'error', text: 'Other modifications were made to the project during generation; the material has been saved to the media pool, please resend the derailing request.' }]);
          else {
            setProposalStale(false);
            setProposal(buildProposal(ops, assistantText, proposalBaseDoc, draft.getState()));
          }
        }
      } finally {
        abortRef.current = null;
        setLiveTool(null);
        setRunning(false);
      }
    },
    [running, projectId],
  );

  // Stop the in-flight turn (Send button switches to stop in flight).
  // The pending skill_guard card will be settled by pressing "Reject" when stopped to avoid Promise hanging.
  const stop = useCallback(() => {
    pendingGuardRef.current?.resolve('deny');
    abortRef.current?.abort();
  }, []);

  // Enhanced prompt word (✨ wand): one-shot LLM rewrite of the composer draft into a
  // clearer, executable editing instruction. No tools, no state change; returns
  // the improved text (or the original on any failure).
  const enhance = useCallback(async (draft: string): Promise<string> => {
    const t = draft.trim();
    if (!t) return draft;
    try {
      const out = (await generateAgentText({
        maxOutputTokens: 400,
        system: 'You are the cue word enhancer for Video Editing Assistant. Rewrite the user's scrawled or spoken editing intention into a clear, specific, and directly executable Chinese editing instruction. Only output the rewritten command itself, without explanation, quotation marks, or line breaks.',
        prompt: t,
      })).trim();
      return out || draft;
    } catch {
      return draft;
    }
  }, []);

  // Apply the selected operations atomically (one undo step). A proposal is
  // rejected if the project changed after it was generated: replaying index- or
  // timeline-sensitive actions onto a different snapshot can silently edit the
  // wrong clip. Side effects stay outside React state updaters.
  const doApply = useCallback((selected: Set<number>) => {
    const p = proposalRef.current;
    if (!p) return;
    const currentDoc = ctxRef.current.getDoc();
    const chosen = p.options[0].operations.filter((_, i) => selected.has(i));
    const result = replayActions(currentDoc, chosen.flatMap((o) => o.actions));
    ctxRef.current.commands.applyDoc(result);
    llmRef.current.push({ role: 'user', content: `(Proposal applied:${chosen.length}/${p.options[0].operations.length} item operations. )` });
    setProposalStale(false);
    setProposal(null);
  }, []);

  const applyProposal = useCallback((selected: Set<number>) => {
    const p = proposalRef.current;
    if (!p) return;
    // Expired items will no longer be discarded directly: hang a banner and wait for the user to choose to still apply/re-propose/cancel.
    if (isProposalStale(p, ctxRef.current.getDoc())) {
      setProposalStale(true);
      return;
    }
    doApply(selected);
  }, [doApply]);

  // "Apply anyway": Replay even though the snapshot has changed - index-sensitive operations may be misplaced and may be decided by the user.
  const forceApplyProposal = useCallback((selected: Set<number>) => { doApply(selected); }, [doApply]);

  // "Re-proposal": Discard the old card and ask the agent to re-promote the equivalent modification according to the current timeline.
  const reProposeStale = useCallback(() => {
    if (!proposalRef.current) return;
    setProposalStale(false);
    setProposal(null);
    proposalRef.current = null;
    void send('(The project has changed since the last proposal was generated. Please base it on the current <editor_state> Re-propose a revised proposal that is equivalent to the previous proposal. )');
  }, [send]);

  const rejectProposal = useCallback(() => {
    if (!proposalRef.current) return;
    setProposalStale(false);
    // skill_guard Deny follow-up: agent must not auto-retry generation.
    llmRef.current.push({
      role: 'user',
      content: [
        'User clicked Deny and rejected this generation task. They may want adjustments; do not retry automatically.',
        '(The user rejected the above proposal and no changes were applied. Do not automatically retry the build.)',
      ].join('\n'),
    });
    setProposal(null);
  }, []);

  // Clear the conversation: drop the rendered rows + the LLM history +
  // the persisted copy + any pending proposal, so a fresh conversation starts
  // (does NOT touch the timeline).
  const clearHistory = useCallback(() => {
    if (running) return;
    llmRef.current = initialMessages();
    llmProviderRef.current = PROVIDER;
    setProposal(null);
    setMessages([]);
    void clearChat(projectId);
    void clearProposal(projectId);
  }, [running, projectId]);

  return {
    messages, running, hydrated, send, stop, enhance, clearHistory,
    proposal, applyProposal, rejectProposal, proposalStale, forceApplyProposal, reProposeStale,
    pendingGuard, liveTool,
  };
}
