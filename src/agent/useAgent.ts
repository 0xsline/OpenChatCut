import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveAgentReferences } from './context';
import type { AgentContext, AgentReference } from './context';
import type { LLMMessage } from './runtime';
import { normalizeLlmProvider, PROVIDER } from './providerConfig';
import type { LlmProvider } from './providerConfig';
import { normalizeLlmMessages, prepareMessagesForProvider } from './messages';
import { makeDraft, replayActions } from '../editor/store';
import { buildOperation, buildProposal, isProposalStale, partitionProposalActions, type Operation, type Proposal } from './proposal';
import { isCostAllowed, rememberCostAllowed, type GuardDecision } from './skills/costGuard';
import { loadChat, saveChat } from '../persist/projectStore';
import { loadProposal, saveProposal, clearProposal } from '../persist/proposalStore';
import { saveAutomaticVersion } from '../persist/versionStore';
import { getAgentModelSnapshot, isAgentModelReady } from './model-selection';
import {
  appendRejectedProposal,
  enhanceAgentPrompt,
  initialAgentMessages,
  preloadAgentRuntime,
  type DisplayMessage,
  type LiveTool,
  type PendingGuard,
} from './agent-session';
import { useAgentContextUsage } from './context-usage';
import { ToolFailureTracker } from './toolFailure';
import {
  appendAgentChange,
  canRollbackAgentChange,
  createAgentChangeSession,
  parseAgentChangeLog,
  rollbackAgentChange,
  type AgentChangeSession,
} from './changeLog';


export function useAgent(ctx: AgentContext, projectId: string, yoloAutoApply = false) {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [changeLog, setChangeLog] = useState<AgentChangeSession[]>([]);
  const [running, setRunning] = useState(false);
  // true once this project's saved chat has been loaded — consumers that want to act
  // "only on a genuinely empty chat" (e.g. scenario-preset composer seeding) gate on it
  const [hydrated, setHydrated] = useState(false);
  // pending edit proposal awaiting the user's apply/reject
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // Proposal expired banner (three choices: still apply / re-propose / cancel)
  const [proposalStale, setProposalStale] = useState(false);
  // Pre-cost-guard pending card + tool parameter real-time stream (all temporary)
  const [pendingGuard, setPendingGuard] = useState<PendingGuard | null>(null);
  const [liveTool, setLiveTool] = useState<LiveTool | null>(null);
  const pendingGuardRef = useRef<PendingGuard | null>(null);
  pendingGuardRef.current = pendingGuard;
  const llmRef = useRef<LLMMessage[]>(initialAgentMessages());
  const {
    usage: contextUsage,
    usageRef: contextUsageRef,
    replace: replaceContextUsage,
    refreshEstimate: refreshEstimatedContextUsage,
  } = useAgentContextUsage(llmRef);
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
  const applyingProposalRef = useRef(false);
  const toolFailuresRef = useRef(new ToolFailureTracker());

  // hydrate chat + pending proposal on mount / project switch
  useEffect(() => {
    let alive = true;
    hydratedRef.current = false;
    toolFailuresRef.current.clear();
    setHydrated(false);
    setChangeLog([]);
    setProposal(null);
    setProposalStale(false);
    void (async () => {
      const [saved, pending] = await Promise.all([loadChat(projectId), loadProposal(projectId)]);
      if (!alive) return;
      setMessages(saved ? (saved.messages as DisplayMessage[]) : []);
      setChangeLog(parseAgentChangeLog(saved?.changeLog));
      if (saved) {
        const sourceProvider = normalizeLlmProvider(saved.llmProvider ?? 'anthropic');
        llmRef.current = prepareMessagesForProvider(
          normalizeLlmMessages(saved.llm),
          sourceProvider,
          PROVIDER,
        );
      } else {
        llmRef.current = initialAgentMessages();
      }
      toolFailuresRef.current.restore(saved?.toolFailures);
      refreshEstimatedContextUsage();
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
  }, [projectId, refreshEstimatedContextUsage]);

  // persist on turn / proposal boundaries — never mid-stream (running) so IDB
  // isn't hammered per token; `proposal` dep captures apply/reject (they push to llmRef).
  useEffect(() => {
    if (!hydratedRef.current || running) return;
    void saveChat(projectId, {
      messages,
      llm: llmRef.current,
      changeLog,
      llmFormat: 'ai-sdk-v1',
      llmProvider: llmProviderRef.current,
      toolFailures: toolFailuresRef.current.snapshot(),
    });
    if (proposal) void saveProposal(projectId, proposal);
    else void clearProposal(projectId);
  }, [messages, changeLog, running, proposal, projectId]);

  const send = useCallback(
    async (text: string, opts?: { askOnly?: boolean; references?: AgentReference[] }) => {
      const trimmed = text.trim();
      if (!trimmed || running || proposalRef.current || !isAgentModelReady(getAgentModelSnapshot())) return; // resolve a pending proposal and require a configured model
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
      refreshEstimatedContextUsage();
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
        getUndoTarget: ctxRef.current.getUndoTarget,
        getRedoTarget: ctxRef.current.getRedoTarget,
      };
      const ops: Operation[] = [];
      const persistentOps: Operation[] = [];
      let persistentBeforeDoc: typeof baseDoc | null = null;
      let persistentSnapshot = Promise.resolve();
      let persistentSaveError: unknown;
      let proposalBaseDoc = baseDoc;
      let draftInvalidated = false;
      let assistantText = '';
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const { runAgent } = await preloadAgentRuntime();
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
              if (!persistentBeforeDoc) {
                persistentBeforeDoc = observed;
                persistentSnapshot = saveAutomaticVersion(projectId, 'Agent 修改前', observed).then(
                  () => undefined,
                  (error) => { persistentSaveError = error; },
                );
                if (observed !== baseDoc) draftInvalidated = true;
              } else if (observed !== persistentBeforeDoc) {
                draftInvalidated = true;
              }
              proposalBaseDoc = replayActions(proposalBaseDoc, persistent);
              persistentOps.push(buildOperation(ev.name, (ev.args ?? {}) as Record<string, unknown>, persistent));
            }
            if (proposed.length) ops.push(buildOperation(ev.name, (ev.args ?? {}) as Record<string, unknown>, proposed));
          } else if (ev.type === 'max-turns') {
            setMessages((m) => [...m, { role: 'continue', text: String(ev.turns) }]);
          } else if (ev.type === 'context-usage') {
            replaceContextUsage(ev.usage);
          } else {
            setMessages((m) => [...m, { role: 'error', text: ev.message }]);
          }
        }, {
          askOnly: opts?.askOnly,
          signal: ac.signal,
          previousContextUsage: contextUsageRef.current ?? undefined,
          toolFailures: toolFailuresRef.current,
          // Pre-cost-guard: YOLO mode releases paid tools without a card
          // (explicit user choice); otherwise remembered authorizations
          // release directly and the rest hang a confirmation card.
          onSkillGuard: (guard) => {
            if (yoloAutoApply || isCostAllowed(guard.skill, projectId)) return Promise.resolve<GuardDecision>('allow-once');
            return new Promise<GuardDecision>((resolve) => {
              setPendingGuard({
                ...guard,
                resolve: (decision) => {
                  setPendingGuard(null);
                  if (decision === 'allow-scope') rememberCostAllowed(guard.skill, projectId);
                  resolve(decision);
                },
              });
            });
          },
        });
        await persistentSnapshot;
        if (persistentSaveError) {
          setMessages((current) => [...current, {
            role: 'error',
            text: '无法创建修改前版本，Agent 改动未应用。请检查本地存储后重试。',
          }]);
          return;
        }
        llmProviderRef.current = PROVIDER;
        if (persistentBeforeDoc && persistentOps.length) {
          const currentDoc = ctxRef.current.getDoc();
          if (draftInvalidated || currentDoc !== persistentBeforeDoc) {
            setMessages((current) => [...current, {
              role: 'error',
              text: '生成期间工程发生了其他修改；Agent 改动未应用，请重新发送请求。',
            }]);
            return;
          }
          const afterDoc = replayActions(
            currentDoc,
            persistentOps.flatMap((operation) => operation.actions),
          );
          ctxRef.current.commands.applyDoc(afterDoc);
          const session = createAgentChangeSession(
            assistantText,
            persistentOps,
            persistentBeforeDoc,
            afterDoc,
            true,
          );
          setChangeLog((current) => appendAgentChange(current, session));
        }
        if (!ac.signal.aborted && ops.length) {
          if (draftInvalidated) setMessages((m) => [...m, { role: 'error', text: '生成期间工程发生了其他修改；素材已保存到媒体池，请重新发送落轨请求。' }]);
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
    [running, projectId, refreshEstimatedContextUsage, replaceContextUsage, contextUsageRef, yoloAutoApply],
  );

  // Stop the in-flight turn (Send button switches to stop in flight).
  // The pending cost-guard card will be settled by pressing "Reject" when stopped to avoid Promise hanging.
  const stop = useCallback(() => {
    pendingGuardRef.current?.resolve('deny');
    toolFailuresRef.current.clear();
    abortRef.current?.abort();
  }, []);

  const enhance = useCallback(enhanceAgentPrompt, []);

  // Apply the selected operations atomically (one undo step). A proposal is
  // rejected if the project changed after it was generated: replaying index- or
  // timeline-sensitive actions onto a different snapshot can silently edit the
  // wrong clip. Side effects stay outside React state updaters.
  const doApply = useCallback(async (selected: Set<number>) => {
    const p = proposalRef.current;
    if (!p) return;
    if (applyingProposalRef.current) return;
    applyingProposalRef.current = true;
    const currentDoc = ctxRef.current.getDoc();
    const chosen = p.options[0].operations.filter((_, i) => selected.has(i));
    const result = replayActions(currentDoc, chosen.flatMap((o) => o.actions));
    try {
      await saveAutomaticVersion(projectId, 'Agent 修改前', currentDoc);
      if (proposalRef.current !== p) return;
      if (ctxRef.current.getDoc() !== currentDoc) {
        setProposalStale(true);
        return;
      }
      ctxRef.current.commands.applyDoc(result);
      const session = createAgentChangeSession(p.summary, chosen, currentDoc, result);
      setChangeLog((current) => appendAgentChange(current, session));
      llmRef.current.push({ role: 'user', content: `（已应用提案：${chosen.length}/${p.options[0].operations.length} 项操作。）` });
      refreshEstimatedContextUsage();
      setProposalStale(false);
      setProposal(null);
    } catch {
      setMessages((current) => [...current, {
        role: 'error',
        text: '无法创建修改前版本，提案未应用。请检查本地存储后重试。',
      }]);
    } finally {
      applyingProposalRef.current = false;
    }
  }, [projectId, refreshEstimatedContextUsage]);

  const applyProposal = useCallback((selected: Set<number>) => {
    const p = proposalRef.current;
    if (!p) return;
    // Expired items will no longer be discarded directly: hang a banner and wait for the user to choose to still apply/re-propose/cancel.
    if (isProposalStale(p, ctxRef.current.getDoc())) {
      setProposalStale(true);
      return;
    }
    void doApply(selected);
  }, [doApply]);

  // "Apply anyway": Replay even though the snapshot has changed - index-sensitive operations may be misplaced and may be decided by the user.
  const forceApplyProposal = useCallback((selected: Set<number>) => { void doApply(selected); }, [doApply]);

  // "Re-proposal": Discard the old card and ask the agent to re-promote the equivalent modification according to the current timeline.
  const reProposeStale = useCallback(() => {
    if (!proposalRef.current) return;
    setProposalStale(false);
    setProposal(null);
    proposalRef.current = null;
    void send('（工程在上一提案生成后发生了变化。请基于当前 <editor_state> 重新提出与上一提案等价的修改方案。）');
  }, [send]);

  const rejectProposal = useCallback(() => {
    if (!proposalRef.current) return;
    setProposalStale(false);
    llmRef.current = appendRejectedProposal(llmRef.current);
    refreshEstimatedContextUsage();
    setProposal(null);
  }, [refreshEstimatedContextUsage]);

  const clearHistory = useCallback(() => {
    if (running) return;
    llmRef.current = initialAgentMessages();
    toolFailuresRef.current.clear();
    llmProviderRef.current = PROVIDER;
    setProposal(null);
    setMessages([]);
    replaceContextUsage(null);
    void clearProposal(projectId);
  }, [running, projectId, replaceContextUsage]);

  const rollbackChangeSession = useCallback((id: string, force = false): boolean => {
    const session = changeLog.find((item) => item.id === id);
    if (!session) return false;
    const previous = rollbackAgentChange(session, ctxRef.current.getDoc(), force);
    if (!previous) return false;
    ctxRef.current.commands.applyDoc(previous);
    return true;
  }, [changeLog]);

  const canRollbackChangeSession = useCallback((id: string): boolean => {
    const session = changeLog.find((item) => item.id === id);
    return !!session && canRollbackAgentChange(session, ctxRef.current.getDoc());
  }, [changeLog]);

  return {
    messages, running, hydrated, send, stop, enhance, clearHistory, contextUsage,
    proposal, applyProposal, rejectProposal, proposalStale, forceApplyProposal, reProposeStale,
    pendingGuard, liveTool, changeLog, rollbackChangeSession, canRollbackChangeSession,
  };
}
