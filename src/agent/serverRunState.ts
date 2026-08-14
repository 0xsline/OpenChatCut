import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { AgentContext } from './context';
import type { DisplayMessage, LiveTool } from './agent-session';
import type { AgentContextUsage } from './context-compaction';
import {
  appendStreamingMessage,
  appendStreamingThinking as appendStreamingThinkingMessage,
} from './serverRunRecovery';
import {
  loadAgentSettings,
  type AgentSettings,
} from './settings/agentSettings';
import { ServerRunEventSession } from './serverRunEventSession';
import {
  ServerRunToolExecutor,
  type ServerToolExecutorCallbacks,
} from './serverRunToolExecutor';
import type { ServerRunOptions } from './serverRunProtocol';

export interface MutableServerRunRef<T> {
  current: T;
}

export interface ServerRunRefs {
  readonly enabled: MutableServerRunRef<boolean>;
  readonly ready: MutableServerRunRef<boolean>;
  readonly running: MutableServerRunRef<boolean>;
  readonly context: MutableServerRunRef<AgentContext>;
  readonly settings: MutableServerRunRef<AgentSettings>;
  readonly options: MutableServerRunRef<ServerRunOptions>;
  readonly activeOptions: MutableServerRunRef<ServerRunOptions | null>;
  readonly abort: MutableServerRunRef<AbortController | null>;
  readonly runId: MutableServerRunRef<string | null>;
  readonly capability: MutableServerRunRef<string | null>;
  readonly runProject: MutableServerRunRef<string | null>;
  readonly cursor: MutableServerRunRef<number>;
  readonly terminalRun: MutableServerRunRef<string | null>;
  readonly finalizingRun: MutableServerRunRef<string | null>;
  readonly staleRecoveryRun: MutableServerRunRef<string | null>;
  readonly assistantText: MutableServerRunRef<string>;
  readonly assistantThinking: MutableServerRunRef<string>;
  readonly subscribe: MutableServerRunRef<((runId: string) => void) | null>;
  readonly abandonRecovery: MutableServerRunRef<(runId: string, error: unknown) => void>;
  readonly runExecutor: MutableServerRunRef<ServerRunToolExecutor | null>;
}

export interface ServerRunState {
  readonly refs: ServerRunRefs;
  readonly messages: DisplayMessage[];
  readonly running: boolean;
  readonly liveTool: LiveTool | null;
  readonly contextUsage: AgentContextUsage | null;
  readonly setRunning: Dispatch<SetStateAction<boolean>>;
  readonly setLiveTool: Dispatch<SetStateAction<LiveTool | null>>;
  readonly setContextUsage: Dispatch<SetStateAction<AgentContextUsage | null>>;
  readonly updateMessages: (update: (current: DisplayMessage[]) => DisplayMessage[]) => void;
  readonly appendMessage: (message: DisplayMessage) => void;
  readonly appendStreamingText: (delta: string) => void;
  readonly appendStreamingThinking: (delta: string) => void;
  readonly eventSession: ServerRunEventSession;
  readonly toolExecutor: ServerRunToolExecutor;
}

interface ServerRunMessageState {
  readonly messages: DisplayMessage[];
  readonly updateMessages: ServerRunState['updateMessages'];
  readonly appendMessage: ServerRunState['appendMessage'];
  readonly appendStreamingText: ServerRunState['appendStreamingText'];
  readonly appendStreamingThinking: ServerRunState['appendStreamingThinking'];
}

function useServerRunRefs(ctx: AgentContext, options: ServerRunOptions): ServerRunRefs {
  const enabled = useRef(options.enabled);
  const ready = useRef(options.session?.hydrated ?? true);
  const running = useRef(false);
  const context = useRef(ctx);
  const settings = useRef(loadAgentSettings());
  const optionRef = useRef(options);
  const activeOptions = useRef<ServerRunOptions | null>(null);
  const abort = useRef<AbortController | null>(null);
  const runId = useRef<string | null>(null);
  const capability = useRef<string | null>(null);
  const runProject = useRef<string | null>(null);
  const cursor = useRef(0);
  const terminalRun = useRef<string | null>(null);
  const finalizingRun = useRef<string | null>(null);
  const staleRecoveryRun = useRef<string | null>(null);
  const assistantText = useRef('');
  const assistantThinking = useRef('');
  const subscribe = useRef<((runId: string) => void) | null>(null);
  const abandonRecovery = useRef<(runId: string, error: unknown) => void>(() => undefined);
  const runExecutor = useRef<ServerRunToolExecutor | null>(null);
  enabled.current = options.enabled;
  ready.current = options.session?.hydrated ?? true;
  context.current = ctx;
  settings.current = loadAgentSettings();
  optionRef.current = options;
  const bundle = useRef<ServerRunRefs | null>(null);
  bundle.current ??= {
    enabled, ready, running, context, settings, options: optionRef, activeOptions,
    abort, runId, capability, runProject, cursor, terminalRun,
    finalizingRun, staleRecoveryRun, assistantText, assistantThinking, subscribe, abandonRecovery,
    runExecutor,
  };
  return bundle.current;
}

function useServerRunMessages(
  refs: ServerRunRefs,
  options: ServerRunOptions,
): ServerRunMessageState {
  const [localMessages, setLocalMessages] = useState<DisplayMessage[]>([]);
  const updateMessages = useCallback((
    update: (current: DisplayMessage[]) => DisplayMessage[],
  ) => {
    const session = (refs.activeOptions.current ?? refs.options.current).session;
    if (session) session.updateMessages(update);
    else setLocalMessages(update);
  }, [refs]);
  const appendMessage = useCallback((message: DisplayMessage) => {
    updateMessages((current) => [...current, message]);
  }, [updateMessages]);
  const appendStreamingText = useCallback((delta: string) => {
    refs.assistantText.current += delta;
    updateMessages((current) => appendStreamingMessage(current, delta));
  }, [refs, updateMessages]);
  const appendStreamingThinking = useCallback((delta: string) => {
    refs.assistantThinking.current += delta;
    updateMessages((current) => appendStreamingThinkingMessage(current, delta));
  }, [refs, updateMessages]);
  return {
    messages: options.session?.messages ?? localMessages,
    updateMessages,
    appendMessage,
    appendStreamingText,
    appendStreamingThinking,
  };
}

function executorCallbacks(
  refs: ServerRunRefs,
  updateMessages: ServerRunState['updateMessages'],
  setLiveTool: Dispatch<SetStateAction<LiveTool | null>>,
  retryStream: (runId: string) => void,
): ServerToolExecutorCallbacks {
  return {
    ctx: () => refs.context.current,
    settings: () => refs.settings.current,
    onToolAction: (action) => (
      refs.activeOptions.current ?? refs.options.current
    ).onToolAction?.(action),
    updateMessages,
    setLiveTool,
    retryStream,
    abandonRecovery: (runId, error) => refs.abandonRecovery.current(runId, error),
  };
}

function useServerRunToolExecutor(
  projectId: string,
  refs: ServerRunRefs,
  eventSession: ServerRunEventSession,
  updateMessages: ServerRunState['updateMessages'],
  setLiveTool: Dispatch<SetStateAction<LiveTool | null>>,
): ServerRunToolExecutor {
  const retryStream = useCallback((runId: string) => {
    eventSession.retry(runId);
  }, [eventSession]);
  const executor = useMemo(() => new ServerRunToolExecutor(
    projectId,
    executorCallbacks(refs, updateMessages, setLiveTool, retryStream),
  ), [projectId, refs, retryStream, setLiveTool, updateMessages]);
  executor.configure(executorCallbacks(
    refs,
    updateMessages,
    setLiveTool,
    retryStream,
  ));
  return executor;
}

export function useServerRunState(
  ctx: AgentContext,
  projectId: string,
  options: ServerRunOptions,
): ServerRunState {
  const refs = useServerRunRefs(ctx, options);
  const [running, setRunning] = useState(false);
  const [liveTool, setLiveTool] = useState<LiveTool | null>(null);
  const [contextUsage, setContextUsage] = useState<AgentContextUsage | null>(null);
  const eventSession = useMemo(
    () => new ServerRunEventSession((runId) => refs.subscribe.current?.(runId)),
    [refs],
  );
  const messageState = useServerRunMessages(refs, options);
  const toolExecutor = useServerRunToolExecutor(
    projectId,
    refs,
    eventSession,
    messageState.updateMessages,
    setLiveTool,
  );
  return {
    refs,
    running,
    liveTool,
    contextUsage,
    setRunning,
    setLiveTool,
    setContextUsage,
    eventSession,
    toolExecutor,
    ...messageState,
  };
}
