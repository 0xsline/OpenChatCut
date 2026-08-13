import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import type { AgentContext } from '../../agent/context';
import type { TimelineState } from '../../editor/types';
import { trackAlias } from '../../editor/types';
import type { EditorDragPayload } from '../../editor/editorDrag';
import { preloadAgentRuntime, type DisplayMessage } from '../../agent/agent-session';
import type { AgentController } from '../../agent/useAgent';
import { useExternalAgentBridge, type ExternalProposalController } from '../../agent/useExternalAgentBridge';
import { getAgentModelSnapshot, isAgentModelReady } from '../../agent/model-selection';
import { refPromptToken, onSelectionRef, setSelectionRefMode } from '../../agent/selection-refs';
import { setAgentAutoApply } from '../../agent/approval-mode';
import type { AgentSettings } from '../../agent/settings/agentSettings';
import { loadAgentSettings, saveAgentSettings } from '../../agent/settings/agentSettings';
import { useT } from '../../i18n/locale';
import {
  clearComposerDraft,
  loadChatAutoApply,
  loadChatMode,
  loadComposerDraft,
  saveChatAutoApply,
  saveChatMode,
  saveComposerDraft,
} from '../../persist/sessionPrefs';
import { createChatAttachmentImporter, type ChatMediaImporter } from './chatAttachmentImport';
import type { ChatMode, RefItem } from './ChatComposer';
import { editorDragReferences } from './editorDragReference';
import {
  cancelChatAttachmentImportByReference,
  createChatAttachmentLifecycleState,
  pendingChatAttachmentCount,
  removeChatAttachmentReference,
  referencesAfterComposerTextEdit,
  resetChatAttachmentLifecycle,
  upsertChatAttachmentReference,
  type ChatAttachmentLifecycleState,
} from './chatAttachmentLifecycle';
import { useChatAgentController } from './useChatAgentController';
import {
  useChatAutoScroll,
  useChatScrollController,
  type ChatScrollController,
} from './useChatScrollController';

export type { ChatScrollController } from './useChatScrollController';

const MESSAGE_WINDOW_SIZE = 40;
type Translate = (key: string, params?: Record<string, string | number>) => string;
type StateSetter<T> = Dispatch<SetStateAction<T>>;
interface MutableValue<T> { current: T }

export interface ChatPanelProps {
  ctx: AgentContext;
  projectId: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onPreviewState: (state: TimelineState | null) => void;
  seed?: { text: string; nonce: number; references?: RefItem[] } | null;
  creativeMode: string | null;
  onCreativeModeChange: (id: string | null) => void;
  onImportMedia: ChatMediaImporter;
}

export interface ChatComposerController {
  input: string;
  setInput: StateSetter<string>;
  mode: ChatMode;
  setMode: StateSetter<ChatMode>;
  autoApply: boolean;
  setAutoApply: StateSetter<boolean>;
  agentSettings: AgentSettings;
  patchAgent: (patch: Partial<AgentSettings>) => void;
  enhancing: boolean;
  setEnhancing: StateSetter<boolean>;
  selectedRefs: RefItem[];
  selectedRefsRef: MutableValue<RefItem[]>;
  commitSelectedRefs: (references: RefItem[]) => void;
  attachmentLifecycle: ChatAttachmentLifecycleState;
  attachmentLifecycleRef: MutableValue<ChatAttachmentLifecycleState>;
  commitAttachmentLifecycle: (state: ChatAttachmentLifecycleState) => void;
  invalidateAttachmentDraft: () => void;
  pendingAttachmentCount: number;
  selecting: boolean;
  setSelecting: StateSetter<boolean>;
  pasteError: string | null;
  setPasteError: StateSetter<string | null>;
  visibleMessageCount: number;
  setVisibleMessageCount: StateSetter<number>;
  taRef: MutableValue<HTMLTextAreaElement | null>;
}

export interface ChatPanelActions {
  submit: () => void;
  runEnhance: () => Promise<void>;
  insertRef: (reference: RefItem) => void;
  removeRef: (id: string) => void;
  onComposerChange: (value: string) => void;
  importPastedFiles: (files: File[]) => Promise<void>;
  onDropEditorItem: (payload: EditorDragPayload) => void;
}

export interface ChatPanelController {
  props: ChatPanelProps;
  t: Translate;
  agent: AgentController;
  externalProposal: ExternalProposalController;
  composer: ChatComposerController;
  scroll: ChatScrollController;
  actions: ChatPanelActions;
  references: RefItem[];
  visibleFrom: number;
  visibleMessages: DisplayMessage[];
  streamingThinking: boolean;
  runSeed: number;
  changeLogSlot: HTMLElement | null;
}

function useComposerState(projectId: string): ChatComposerController {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<ChatMode>('agent');
  const [autoApply, setAutoApply] = useState(() => loadChatAutoApply(projectId));
  // YOLO mode also releases the runtime confirmation cards: the agent run
  // loop reads the mode through the approval-mode registry (sessionPrefs
  // documents the intent; this is the wiring).
  useEffect(() => { setAgentAutoApply(autoApply); }, [autoApply]);
  const [agentSettings, setAgentSettingsState] = useState<AgentSettings>(() => loadAgentSettings());
  const patchAgent = useCallback((patch: Partial<AgentSettings>) => {
    setAgentSettingsState((prev) => {
      const next = { ...prev, ...patch };
      saveAgentSettings(next);
      return next;
    });
  }, []);
  const [enhancing, setEnhancing] = useState(false);
  const [selectedRefs, setSelectedRefs] = useState<RefItem[]>([]);
  const selectedRefsRef = useRef<RefItem[]>([]);
  const [attachmentLifecycle, setAttachmentLifecycle] = useState(createChatAttachmentLifecycleState);
  const attachmentLifecycleRef = useRef(attachmentLifecycle);
  const [selecting, setSelecting] = useState(false);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [visibleMessageCount, setVisibleMessageCount] = useState(MESSAGE_WINDOW_SIZE);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const commitSelectedRefs = useCallback((references: RefItem[]) => {
    selectedRefsRef.current = references;
    setSelectedRefs(references);
  }, []);
  const commitAttachmentLifecycle = useCallback((next: ChatAttachmentLifecycleState) => {
    if (attachmentLifecycleRef.current === next) return;
    attachmentLifecycleRef.current = next;
    setAttachmentLifecycle(next);
  }, []);
  const invalidateAttachmentDraft = useCallback(() => {
    commitAttachmentLifecycle(resetChatAttachmentLifecycle(attachmentLifecycleRef.current));
  }, [commitAttachmentLifecycle]);
  return {
    input, setInput, mode, setMode, autoApply, setAutoApply, agentSettings, patchAgent,
    enhancing, setEnhancing,
    selectedRefs, selectedRefsRef, commitSelectedRefs, attachmentLifecycle,
    attachmentLifecycleRef, commitAttachmentLifecycle, invalidateAttachmentDraft,
    pendingAttachmentCount: pendingChatAttachmentCount(attachmentLifecycle), selecting,
    setSelecting, pasteError, setPasteError, visibleMessageCount, setVisibleMessageCount, taRef,
  };
}

function useComposerProject(composer: ChatComposerController, projectId: string): void {
  const {
    invalidateAttachmentDraft,
    setInput,
    setMode,
    commitSelectedRefs,
    setPasteError,
    setVisibleMessageCount,
    input,
    mode,
    autoApply,
  } = composer;
  useEffect(() => {
    invalidateAttachmentDraft();
    setInput(loadComposerDraft(projectId));
    setMode(loadChatMode(projectId));
    commitSelectedRefs([]);
    setPasteError(null);
    setVisibleMessageCount(MESSAGE_WINDOW_SIZE);
  }, [
    commitSelectedRefs,
    invalidateAttachmentDraft,
    projectId,
    setInput,
    setMode,
    setPasteError,
    setVisibleMessageCount,
  ]);
  useEffect(() => {
    const id = window.setTimeout(() => saveComposerDraft(projectId, input), 350);
    return () => window.clearTimeout(id);
  }, [input, projectId]);
  useEffect(() => saveChatMode(projectId, mode), [mode, projectId]);
  useEffect(() => saveChatAutoApply(projectId, autoApply), [autoApply, projectId]);
}

function useComposerSeed(
  composer: ChatComposerController,
  seed: ChatPanelProps['seed'],
  collapsed: boolean,
): void {
  useEffect(() => {
    if (!seed) return;
    composer.invalidateAttachmentDraft();
    composer.setPasteError(null);
    composer.setInput(seed.text);
    composer.commitSelectedRefs(seed.references ?? []);
    if (!collapsed) composer.taRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);
}


function useReferenceSelection(
  insertRef: (reference: RefItem) => void,
  composer: ChatComposerController,
  collapsed: boolean,
): void {
  const { selecting, setSelecting } = composer;
  const insertRefRef = useRef(insertRef);
  insertRefRef.current = insertRef;
  useEffect(() => {
    setSelectionRefMode(selecting && !collapsed);
    return () => setSelectionRefMode(false);
  }, [collapsed, selecting]);
  useEffect(() => { if (collapsed) setSelecting(false); }, [collapsed, setSelecting]);
  useEffect(() => onSelectionRef((reference) => insertRefRef.current(reference)), []);
}

function useMessageActions(
  agent: AgentController,
  composer: ChatComposerController,
  projectId: string,
) {
  const submit = useCallback(() => {
    if (!composer.input.trim() || agent.running) return;
    if (!isAgentModelReady(getAgentModelSnapshot()) || pendingChatAttachmentCount(composer.attachmentLifecycleRef.current) > 0) return;
    const references = composer.selectedRefsRef.current;
    composer.invalidateAttachmentDraft();
    const tokens = references.map((reference) => refPromptToken(reference)).join(' ');
    const sendText = references.length
      ? `${composer.input}${composer.input.endsWith(' ') ? '' : ' '}${tokens}`
      : composer.input;
    void agent.send(sendText, { askOnly: composer.mode === 'ask', references });
    composer.setInput('');
    composer.commitSelectedRefs([]);
    clearComposerDraft(projectId);
  }, [agent, composer, projectId]);
  const runEnhance = useCallback(async () => {
    if (!composer.input.trim() || composer.enhancing || agent.running) return;
    if (!isAgentModelReady(getAgentModelSnapshot()) || pendingChatAttachmentCount(composer.attachmentLifecycleRef.current) > 0) return;
    composer.setEnhancing(true);
    try {
      composer.setInput(await agent.enhance(composer.input));
      composer.taRef.current?.focus();
    } finally {
      composer.setEnhancing(false);
    }
  }, [agent, composer]);
  return { submit, runEnhance };
}

function useReferenceActions(ctx: AgentContext, composer: ChatComposerController) {
  const insertRef = useCallback((reference: RefItem) => {
    composer.commitSelectedRefs(upsertChatAttachmentReference(composer.selectedRefsRef.current, reference));
  }, [composer]);
  const removeRef = useCallback((id: string) => {
    const found = composer.selectedRefsRef.current.some((reference) => reference.id === id);
    if (!found) return;
    composer.commitAttachmentLifecycle(
      cancelChatAttachmentImportByReference(composer.attachmentLifecycleRef.current, id),
    );
    composer.commitSelectedRefs(removeChatAttachmentReference(composer.selectedRefsRef.current, id));
  }, [composer]);
  const onComposerChange = useCallback((value: string) => {
    composer.setInput(value);
    const current = composer.selectedRefsRef.current;
    const next = referencesAfterComposerTextEdit(current, composer.input, value);
    let lifecycle = composer.attachmentLifecycleRef.current;
    current.forEach((reference) => {
      if (!next.some((candidate) => candidate.id === reference.id)) {
        lifecycle = cancelChatAttachmentImportByReference(lifecycle, reference.id);
      }
    });
    composer.commitAttachmentLifecycle(lifecycle);
    composer.commitSelectedRefs(next);
  }, [composer]);
  const onDropEditorItem = useCallback((payload: EditorDragPayload) => {
    editorDragReferences(payload, ctx.getDoc().assets ?? []).forEach(insertRef);
  }, [ctx, insertRef]);
  return { insertRef, removeRef, onComposerChange, onDropEditorItem };
}

function useChatActions(
  props: ChatPanelProps,
  t: Translate,
  agent: AgentController,
  composer: ChatComposerController,
): ChatPanelActions {
  const messages = useMessageActions(agent, composer, props.projectId);
  const references = useReferenceActions(props.ctx, composer);
  useReferenceSelection(references.insertRef, composer, props.collapsed);
  const importPastedFiles = createChatAttachmentImporter({
    t,
    onImportMedia: props.onImportMedia,
    lifecycle: () => composer.attachmentLifecycleRef.current,
    references: () => composer.selectedRefsRef.current,
    commitLifecycle: composer.commitAttachmentLifecycle,
    commitReferences: composer.commitSelectedRefs,
    updateInput: composer.setInput,
    setError: composer.setPasteError,
  });
  return { ...messages, ...references, importPastedFiles };
}

function chatReferences(ctx: AgentContext): RefItem[] {
  const doc = ctx.getDoc();
  const state = ctx.getState();
  return [
    ...doc.assets.map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind })),
    ...ctx.templates.slice(0, 40).map((template) => ({
      id: template.id, name: template.name, kind: 'template' as const,
    })),
    ...state.items.map((item) => ({
      id: item.id,
      name: item.name,
      kind: 'item' as const,
      metadata: {
        fps: state.fps,
        timelineId: doc.activeTimelineId,
        itemId: item.id,
        itemKind: item.kind,
        trackId: item.track,
        trackAlias: trackAlias(state, item.track),
        timelineFrameStart: item.startFrame,
        timelineFrameEnd: item.startFrame + item.durationInFrames,
      },
    })),
  ];
}

function useRunPresentation(messages: DisplayMessage[], running: boolean) {
  const runSeedRef = useRef(0);
  if (running && runSeedRef.current === 0) runSeedRef.current = messages.length + 1;
  if (!running) runSeedRef.current = 0;
  const last = messages[messages.length - 1];
  const streamingThinking = running && last?.role === 'assistant' && !!last.thinking && !last.text;
  return { runSeed: runSeedRef.current, streamingThinking };
}

function usePanelEffects(props: ChatPanelProps, agent: AgentController, composer: ChatComposerController): void {
  const { collapsed, onPreviewState } = props;
  const { proposal, applyProposal } = agent;
  useEffect(() => {
    if (!collapsed) void preloadAgentRuntime().catch(() => undefined);
  }, [collapsed]);
  useEffect(() => {
    if (!proposal) onPreviewState(null);
  }, [onPreviewState, proposal]);
  useEffect(() => {
    if (!proposal || !composer.autoApply) return;
    if (!composer.autoApply) return;
    const all = new Set(proposal.options[0].operations.map((_, index) => index));
    applyProposal(all);
  }, [applyProposal, composer.autoApply, proposal]);
}

function useChangeLogSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById('cc-agent-change-log-slot')), []);
  return slot;
}

export function useChatPanelController(props: ChatPanelProps): ChatPanelController {
  const t = useT();
  const composer = useComposerState(props.projectId);
  const agent = useChatAgentController(
    props.ctx,
    props.projectId,
    composer.agentSettings.serverRun,
  );
  const externalProposal = useExternalAgentBridge(props.ctx, props.projectId);
  const scroll = useChatScrollController();
  useComposerProject(composer, props.projectId);
  useComposerSeed(composer, props.seed, props.collapsed);
  useChatAutoScroll(scroll, agent.messages, agent.running, agent.proposal);
  usePanelEffects(props, agent, composer);
  const actions = useChatActions(props, t, agent, composer);
  const references = chatReferences(props.ctx);
  const run = useRunPresentation(agent.messages, agent.running);
  const changeLogSlot = useChangeLogSlot();
  const visibleFrom = Math.max(0, agent.messages.length - composer.visibleMessageCount);
  return {
    props,
    t,
    agent,
    externalProposal,
    composer,
    scroll,
    actions,
    references,
    visibleFrom,
    visibleMessages: agent.messages.slice(visibleFrom),
    ...run,
    changeLogSlot,
  };
}
