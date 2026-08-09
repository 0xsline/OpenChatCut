import { useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentContext } from './context';
import type { AgentContextUsage } from './context-compaction';
import type { LLMMessage } from './runtime';
import { PROVIDER, type LlmProvider } from './providerConfig';
import { initialAgentMessages, type DisplayMessage, type LiveTool, type PendingGuard } from './agent-session';
import { useAgentContextUsage } from './context-usage';
import { ToolFailureTracker } from './toolFailure';
import type { Proposal } from './proposal';
import type { AgentChangeSession } from './changeLog';

type StateSetter<T> = Dispatch<SetStateAction<T>>;
export interface MutableValue<T> { current: T }

export interface AgentHookState {
  messages: DisplayMessage[];
  setMessages: StateSetter<DisplayMessage[]>;
  changeLog: AgentChangeSession[];
  setChangeLog: StateSetter<AgentChangeSession[]>;
  running: boolean;
  setRunning: StateSetter<boolean>;
  hydrated: boolean;
  setHydrated: StateSetter<boolean>;
  proposal: Proposal | null;
  setProposal: StateSetter<Proposal | null>;
  proposalStale: boolean;
  setProposalStale: StateSetter<boolean>;
  pendingGuard: PendingGuard | null;
  setPendingGuard: StateSetter<PendingGuard | null>;
  liveTool: LiveTool | null;
  setLiveTool: StateSetter<LiveTool | null>;
  llmRef: MutableValue<LLMMessage[]>;
  llmProviderRef: MutableValue<LlmProvider>;
  ctxRef: MutableValue<AgentContext>;
  runningRef: MutableValue<boolean>;
  changeLogRef: MutableValue<AgentChangeSession[]>;
  hydratedRef: MutableValue<boolean>;
  hydrationEpochRef: MutableValue<number>;
  proposalRef: MutableValue<Proposal | null>;
  pendingGuardRef: MutableValue<PendingGuard | null>;
  abortRef: MutableValue<AbortController | null>;
  applyingProposalRef: MutableValue<boolean>;
  toolFailuresRef: MutableValue<ToolFailureTracker>;
  contextUsage: AgentContextUsage | null;
  contextUsageRef: MutableValue<AgentContextUsage | null>;
  replaceContextUsage: (next: AgentContextUsage | null) => void;
  refreshEstimatedContextUsage: () => void;
}

export function useAgentState(ctx: AgentContext): AgentHookState {
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [changeLog, setChangeLog] = useState<AgentChangeSession[]>([]);
  const [running, setRunning] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [proposalStale, setProposalStale] = useState(false);
  const [pendingGuard, setPendingGuard] = useState<PendingGuard | null>(null);
  const [liveTool, setLiveTool] = useState<LiveTool | null>(null);
  const llmRef = useRef<LLMMessage[]>(initialAgentMessages());
  const context = useAgentContextUsage(llmRef);
  const llmProviderRef = useRef<LlmProvider>(PROVIDER);
  const ctxRef = useRef(ctx);
  const runningRef = useRef(false);
  const changeLogRef = useRef<AgentChangeSession[]>([]);
  const hydratedRef = useRef(false);
  const hydrationEpochRef = useRef(0);
  const proposalRef = useRef<Proposal | null>(null);
  const pendingGuardRef = useRef<PendingGuard | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const applyingProposalRef = useRef(false);
  const toolFailuresRef = useRef(new ToolFailureTracker());
  ctxRef.current = ctx;
  proposalRef.current = proposal;
  pendingGuardRef.current = pendingGuard;
  runningRef.current = running;
  changeLogRef.current = changeLog;
  return {
    messages, setMessages, changeLog, setChangeLog, running, setRunning, hydrated, setHydrated,
    proposal, setProposal, proposalStale, setProposalStale, pendingGuard, setPendingGuard,
    liveTool, setLiveTool, llmRef, llmProviderRef, ctxRef, hydratedRef, hydrationEpochRef,
    proposalRef, runningRef, changeLogRef, pendingGuardRef, abortRef,
    applyingProposalRef, toolFailuresRef,
    contextUsage: context.usage,
    contextUsageRef: context.usageRef, replaceContextUsage: context.replace,
    refreshEstimatedContextUsage: context.refreshEstimate,
  };
}
