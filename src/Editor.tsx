import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from './theme';
import { ExportDialog } from './export/ExportDialog';
import { TopBar } from './components/TopBar';
import { ChatPanel } from './components/chat/ChatPanel';
import { LibraryPanel } from './library/LibraryPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { InspectorPanel } from './components/InspectorPanel';
import { Timeline } from './components/timeline/Timeline';
import { TimelineTabs } from './components/timeline/TimelineTabs';
import { Divider } from './components/Divider';
import { DesignStylePanel } from './components/settings/DesignStylePanel';
import { VersionHistory } from './components/VersionHistory';
import { usePersistedState } from './hooks/usePersistedState';
import { useEditor } from './editor/store';
import type { ProjectDoc, TimelineItem, TimelineState } from './editor/types';
import { captionsOnTrack, selectedIdsOf, timelineTrackIds, trackAlias, trackKind } from './editor/types';
import { TEMPLATES } from './editor/initial';
import { saveProject, loadCreativeMode, saveCreativeMode, type ProjectMeta } from './persist/projectStore';
import { importMedia } from './media/upload';
import { importUploadedMedia } from './media/mobileImport';
import type { MobileUploadRecord } from './media/mobileUploadApi';
import { ensureMediaSrcs } from './persist/mediaBlobStore';
import { resumeOpenGenerationJobs } from './persist/jobRegistryStore';
import { enqueueTranscription, shouldTranscribe } from './transcript/transcribe-jobs';
import { enqueueVisualAnalysis, refreshVisualAnalysis } from './agent/progress/visual-analysis-jobs';
import type { MediaAsset } from './editor/types';
import { AUDIO_ASSETS } from './audio/library';
import type { Tpl } from './types';
import type { AgentReference } from './agent/context';
import { serializableDefsFor } from './gl/fx/effects';
import { useEditorActions } from './shortcuts/useEditorActions';
import { useT } from './i18n/locale';
import { pluginTemplates, usePluginPacks } from './library/pluginResources';
import type { TimelineShortcutApi } from './shortcuts/timelineApi';
import { ShortcutsDialog } from './shortcuts/ShortcutsDialog';
import { AppToastHost } from './ui/AppToastHost';
import { showAppToast } from './ui/appToast';
import { useExternalAgentBridge } from './agent/useExternalAgentBridge';
import { isolateVoiceOnSrc, strengthFromAudioFxId } from './audio/isolateVoice';
import { analyzeClipLoudness, gainForTarget } from './audio/loudness';
import { analyzeAutoGrade, type AutoGradeResponse } from './color/autoGrade';

interface EditorProps {
  initial: ProjectDoc;
  project: ProjectMeta;
  onHome: () => void;
  onRename: (name: string) => void;
}

const HEADER_H = 41;
const CHAT_MIN_W = 320;
const ASSETS_MIN_W = 176;
const CANVAS_MIN_W = 280;
const TIMELINE_MIN_H = 260;
const SPLITTER_TOTAL_W = 0;
const BASELINE_VIEWPORT_W = 1463;
const BASELINE_CONTENT_H = 761;

interface AutoGradeRecommendation {
  itemId: string;
  itemName: string;
  analysis: AutoGradeResponse;
}

interface AutoGradeSession {
  recommendations: AutoGradeRecommendation[];
  failedCount: number;
}

function isAutoGradeTarget(item: TimelineItem, state: TimelineState): boolean {
  if (item.kind !== 'video' && item.kind !== 'image' && item.kind !== 'gif') return false;
  if (state.tracks?.[item.track]?.locked) return false;
  return /^\/media\/uploads\/[^/]+(?:\?.*)?$/.test(item.src ?? '');
}

export default function Editor({ initial, project, onHome, onRename }: EditorProps) {
  const t = useT();
  const { state, doc, commands, canUndo, canRedo } = useEditor(initial);
  const selectedItem = state.items.find((it) => it.id === state.selectedId) ?? null;
  const trackOptions = useMemo(
    () => timelineTrackIds(state).map((id) => ({
      id,
      alias: trackAlias(state, id),
      name: state.tracks?.[id]?.name,
      kind: trackKind(state, id),
    })),
    [state],
  );
  const captionTracks = trackOptions
    .filter((option) => option.kind === 'caption')
    .map((option) => ({ ...option, captions: captionsOnTrack(state, option.id) }));

  // keep live refs so agent tools always read the latest timeline/project
  const stateRef = useRef(state);
  stateRef.current = state;
  const docRef = useRef(doc);
  docRef.current = doc;
// 创作模式:选中的技能 id 注入系统提示，并存入 IDB(不进 undo 历史)。
  const [creativeMode, setCreativeMode] = useState<string | null>(null);
  const creativeModeRef = useRef(creativeMode);
  creativeModeRef.current = creativeMode;
  useEffect(() => { loadCreativeMode(project.id).then(setCreativeMode); }, [project.id]);
  const changeCreativeMode = useCallback((id: string | null) => {
    setCreativeMode(id);
    saveCreativeMode(project.id, id);
  }, [project.id]);
  const playerRef = useRef<PlayerRef | null>(null);
  // 内置 + 已装插件的 MG 模板:agent(browse_library/加 MG)与资源库共用同一份
  const pluginPacks = usePluginPacks();
  const allTemplates = useMemo(
    () => (pluginPacks.length ? [...TEMPLATES, ...pluginTemplates(pluginPacks)] : TEMPLATES),
    [pluginPacks],
  );
  const allTemplatesRef = useRef(allTemplates);
  allTemplatesRef.current = allTemplates;
  const agentCtx = useMemo(
    () => ({
      commands,
      getState: () => stateRef.current,
      getDoc: () => docRef.current,
      getCreativeMode: () => creativeModeRef.current,
      setCreativeMode: changeCreativeMode,
      get templates() { return allTemplatesRef.current; },
      audio: AUDIO_ASSETS,
      getProjectId: () => project.id,
      openProject: async (projectId: string) => {
        // Flush current doc before hash navigation remounts the editor.
        try {
          await saveProject(project.id, docRef.current);
        } catch {
          /* ignore */
        }
        if (projectId === project.id) return { ok: true };
        window.location.hash = `#/editor/${projectId}`;
        return { ok: true };
      },
      onProjectRenamed: onRename,
    }),
    [commands, project.id, onRename, changeCreativeMode],
  );
  useExternalAgentBridge(agentCtx, project.id);

  // a pending proposal's draft result, previewed in the player (null = committed)
  const [previewState, setPreviewState] = useState<TimelineState | null>(null);
  // Automatic color correction always previews first. Applying the complete
  // session uses one reducer batch, so multi-clip correction is one undo step.
  const [autoGradeBusy, setAutoGradeBusy] = useState(false);
  const [autoGradeSession, setAutoGradeSession] = useState<AutoGradeSession | null>(null);
  const autoGradeRequestRef = useRef(0);
  const autoGradeSelectionKey = selectedIdsOf(state).join('\u0000');
  const autoGradeTargets = useMemo(() => {
    const selected = new Set(selectedIdsOf(state));
    return state.items.filter((item) => selected.has(item.id) && isAutoGradeTarget(item, state));
  }, [state]);
  useEffect(() => {
    autoGradeRequestRef.current += 1;
    setAutoGradeBusy(false);
    setAutoGradeSession(null);
  }, [autoGradeSelectionKey, project.id]);

  const cancelAutoGrade = useCallback(() => {
    autoGradeRequestRef.current += 1;
    setAutoGradeBusy(false);
    setAutoGradeSession(null);
  }, []);

  const analyzeSelectedColor = useCallback(async () => {
    const snapshot = stateRef.current;
    const selected = new Set(selectedIdsOf(snapshot));
    const targets = snapshot.items.filter((item) => selected.has(item.id) && isAutoGradeTarget(item, snapshot));
    if (!targets.length) {
      showAppToast(t('请选择已导入媒体池的视频、图片或 GIF 片段'), { error: true });
      return;
    }
    const requestId = ++autoGradeRequestRef.current;
    setPreviewState(null);
    setAutoGradeSession(null);
    setAutoGradeBusy(true);
    const recommendations: AutoGradeRecommendation[] = [];
    const cache = new Map<string, Promise<AutoGradeResponse>>();
    let firstError: unknown = null;
    for (const item of targets) {
      if (autoGradeRequestRef.current !== requestId) return;
      const startSeconds = Math.max(0, item.srcInFrame ?? 0) / snapshot.fps;
      const durationSeconds = Math.max(1 / snapshot.fps, item.durationInFrames * (item.playbackRate ?? 1) / snapshot.fps);
      const cacheKey = `${item.src}\u0000${startSeconds.toFixed(3)}\u0000${durationSeconds.toFixed(3)}`;
      try {
        let pending = cache.get(cacheKey);
        if (!pending) {
          pending = analyzeAutoGrade({ src: item.src!, startSeconds, durationSeconds });
          cache.set(cacheKey, pending);
        }
        recommendations.push({ itemId: item.id, itemName: item.name, analysis: await pending });
      } catch (error) {
        firstError ??= error;
      }
    }
    if (autoGradeRequestRef.current !== requestId) return;
    try {
      if (!recommendations.length) throw firstError ?? new Error(t('未获得可用的校色结果'));
      const failedCount = targets.length - recommendations.length;
      setAutoGradeSession({ recommendations, failedCount });
      showAppToast(failedCount
        ? t('已预览 {n} 个片段，{failed} 个分析失败', { n: recommendations.length, failed: failedCount })
        : t('自动校色预览已生成，可确认应用或取消'));
    } catch (error) {
      showAppToast(t('自动校色分析失败：{error}', {
        error: error instanceof Error ? error.message : String(error),
      }), { error: true });
    } finally {
      if (autoGradeRequestRef.current === requestId) setAutoGradeBusy(false);
    }
  }, [t]);

  const applyAutoGrade = useCallback(() => {
    if (!autoGradeSession?.recommendations.length) return;
    commands.batch(autoGradeSession.recommendations.map((recommendation) => ({
      type: 'setFilters' as const,
      id: recommendation.itemId,
      patch: recommendation.analysis.filters,
    })), 'Apply automatic color correction');
    const applied = autoGradeSession.recommendations.length;
    setAutoGradeSession(null);
    showAppToast(t('已将自动校色应用到 {n} 个片段', { n: applied }));
  }, [autoGradeSession, commands, t]);

  const autoGradePreviewState = useMemo<TimelineState | null>(() => {
    if (!autoGradeSession) return null;
    const filters = new Map(autoGradeSession.recommendations.map((entry) => [entry.itemId, entry.analysis.filters]));
    return {
      ...state,
      items: state.items.map((item) => {
        const patch = filters.get(item.id);
        return patch ? { ...item, filters: { ...item.filters, ...patch } } : item;
      }),
    };
  }, [autoGradeSession, state]);
  const selectedAutoGrade = autoGradeSession?.recommendations.find((entry) => entry.itemId === state.selectedId) ?? null;
  // library「用 AI 生成」→ prefill the chat composer (nonce forces re-seed of the same text)
  const [chatSeed, setChatSeed] = useState<{ text: string; nonce: number; reference?: AgentReference } | null>(null);
  // 设计风格(品牌)编辑器弹窗。
  const [showDesign, setShowDesign] = useState(false);
  // 版本历史弹窗。
  const [showVersions, setShowVersions] = useState(false);
  // 快捷键帮助。
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** Timeline fills this; Editor binds the global shortcut dispatcher to it. */
  const shortcutApiRef = useRef<TimelineShortcutApi | null>(null);

  // Read the playhead only when an edit needs it. Continuous visual updates are
  // painted inside Timeline so playback does not re-render the whole editor.
  const getPlayhead = useCallback(() => playerRef.current?.getCurrentFrame() ?? 0, []);

  // autosave this project (all timelines) to IndexedDB (debounced) so a reload restores it
  useEffect(() => {
    const id = setTimeout(() => saveProject(project.id, doc), 500);
    return () => clearTimeout(id);
  }, [doc, project.id]);

  // Rehydrate missing /media/uploads files from IDB blob cache (disk wipe / new clone).
  // Also resume any open generation jobs so refresh mid-generate still lands assets.
  useEffect(() => {
    let alive = true;
    const currentDoc = docRef.current;
    const srcs = [
      ...currentDoc.assets.map((a) => a.src),
      ...currentDoc.timelines.flatMap((tl) => tl.items.map((it) => it.src).filter(Boolean) as string[]),
    ];
    void ensureMediaSrcs(srcs).then((r) => {
      if (!alive || r.restored.length === 0) return;
      try { playerRef.current?.seekTo(playerRef.current.getCurrentFrame()); } catch { /* ignore */ }
    });
    void resumeOpenGenerationJobs(project.id, {
      getState: () => stateRef.current,
      onAsset: (asset) => {
        if (!alive) return;
        // Avoid dup if agent already ingested before refresh.
        if ((docRef.current.assets ?? []).some((a) => a.id === asset.id || a.src === asset.src)) return;
        commands.addAsset(asset);
      },
      timeoutSeconds: 180,
    });
    return () => { alive = false; };
  }, [project.id, commands]); // only on open / project switch

  // Switching timelines: seek the shared Player so it doesn't show a stale frame.
  // 跳过挂载首跑——否则会把 Timeline 侧刚从 sessionPrefs 恢复的播放头顶回 0
  //(父 effect 晚于子 effect,恢复必被覆盖)。
  const firstTimelineRef = useRef(true);
  useEffect(() => {
    if (firstTimelineRef.current) { firstTimelineRef.current = false; return; }
    playerRef.current?.seekTo(0);
  }, [doc.activeTimelineId]);

  // Default panel geometry is normalized against a 1463×802 CSS-pixel viewport.
  const viewportW = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const viewportH = typeof window === 'undefined' ? 900 : window.innerHeight;
  const [chatW, setChatW] = usePersistedState('openchatcut.chatW.ui-v1', Math.max(CHAT_MIN_W, Math.round(viewportW * 356 / BASELINE_VIEWPORT_W)));
  const [libW, setLibW] = usePersistedState('openchatcut.libW.ui-v1', Math.max(ASSETS_MIN_W, Math.round(viewportW * 406 / BASELINE_VIEWPORT_W)));
  const [timelineH, setTimelineH] = usePersistedState('openchatcut.timelineH.ui-v1', Math.max(TIMELINE_MIN_H, Math.round((viewportH - HEADER_H) * 350 / BASELINE_CONTENT_H)));
  const [chatCollapsed, setChatCollapsed] = usePersistedState('cc.chatCollapsed', false);
  const addTemplate = useCallback((tpl: Tpl) => commands.addMotionGraphic(tpl), [commands]);
  // Add an asset to the pool AND kick off "上传即转写" ASR for audio-bearing media.
  // On completion the transcript is written onto the asset (so later placements inherit
  // it) and backfilled onto any clip already placed from this asset (drag-to-canvas /
  // voiceover), so the口播 is editable as soon as ASR lands.
  // Kick ASR. Prefer race-ahead asrPath (extract started right after master upload).
  const startAssetTranscription = useCallback((
    asset: Pick<MediaAsset, 'id' | 'src' | 'kind'> & { name?: string },
    asrPath?: string | null | Promise<string | null>,
  ) => {
    if (!shouldTranscribe(asset.kind)) return;
    commands.setAssetTranscription(asset.id, { transcribeStatus: 'running', transcribeError: undefined });
    enqueueTranscription(asset, {
      asrPath,
      onComplete: (job) => {
        if (job.status === 'done' && job.words?.length) {
          commands.setAssetTranscription(asset.id, { transcript: job.words, transcribeStatus: 'done', transcribeError: undefined });
          for (const it of stateRef.current.items) {
            if ((it.src === asset.src || (asset.name !== undefined && it.name === asset.name)) && !(it.transcript?.length)) {
              commands.setItemTranscript(it.id, job.words);
            }
          }
        } else if (job.status === 'failed') {
          commands.setAssetTranscription(asset.id, { transcribeStatus: 'failed', transcribeError: job.error });
        }
      },
    });
  }, [commands]);

  /** Full ingest for already-ready assets (generated media, voice, etc.). */
  const ingestToPool = useCallback((asset: MediaAsset) => {
    commands.addAsset(shouldTranscribe(asset.kind) ? { ...asset, transcribeStatus: 'running' } : asset);
    startAssetTranscription(asset);
    if (asset.kind !== 'audio') enqueueVisualAnalysis(asset);
  }, [commands, startAssetTranscription]);

  const importMobileUpload = useCallback(async (record: MobileUploadRecord) => {
    ingestToPool(await importUploadedMedia(record, stateRef.current.fps));
  }, [ingestToPool]);

  // Progressive import: blob placeholder → upload → (ASR extract || normalize race) → relink.
  const importToPool = useCallback(async (file: File, onProgress?: (ratio: number) => void) => {
    let placeholderId: string | null = null;
    let asrPath: Promise<string | null> | undefined;
    try {
      return await importMedia(file, stateRef.current.fps, {
        onProgress,
        onPlaceholder: (asset) => {
          placeholderId = asset.id;
          commands.addAsset(shouldTranscribe(asset.kind) ? { ...asset, transcribeStatus: 'running' } : asset);
        },
        onUploaded: (info) => {
          asrPath = info.asrPath;
          // Start ASR as soon as master lands — don't wait for normalize.
          if (info.kind === 'video' || info.kind === 'audio') {
            startAssetTranscription({ id: info.assetId, src: info.src, kind: info.kind }, info.asrPath);
          }
        },
        onReady: (asset) => {
          commands.relinkMediaAsset(asset.id, {
            src: asset.src,
            name: asset.name,
            durationInFrames: asset.durationInFrames,
            width: asset.width,
            height: asset.height,
            kind: asset.kind,
          });
          // Images / if onUploaded skipped: kick ASR now (idempotent if already running).
          if (!asrPath && shouldTranscribe(asset.kind)) startAssetTranscription(asset);
          if (asset.kind !== 'audio') refreshVisualAnalysis(asset);
        },
      });
    } catch (err) {
      if (placeholderId) commands.removeMediaAsset(placeholderId);
      throw err;
    }
  }, [commands, startAssetTranscription]);

  const importToCanvas = useCallback(async (file: File, onProgress?: (ratio: number) => void) => {
    let placeholderId: string | null = null;
    let placeholderSrc: string | null = null;
    let asrPath: Promise<string | null> | undefined;
    try {
      await importMedia(file, stateRef.current.fps, {
        onProgress,
        onPlaceholder: (a) => {
          placeholderId = a.id;
          placeholderSrc = a.src;
          commands.addAsset(shouldTranscribe(a.kind) ? { ...a, transcribeStatus: 'running' } : a);
          commands.addMediaItem(a); // timeline preview via blob: during upload
        },
        onUploaded: (info) => {
          asrPath = info.asrPath;
          if (info.kind === 'video' || info.kind === 'audio') {
            startAssetTranscription({ id: info.assetId, src: info.src, kind: info.kind }, info.asrPath);
          }
        },
        onReady: (a) => {
          commands.relinkMediaAsset(a.id, {
            src: a.src,
            name: a.name,
            durationInFrames: a.durationInFrames,
            width: a.width,
            height: a.height,
            kind: a.kind,
          });
          if (!asrPath && shouldTranscribe(a.kind)) startAssetTranscription(a);
          if (a.kind !== 'audio') refreshVisualAnalysis(a);
        },
      });
    } catch (err) {
      if (placeholderId) commands.removeMediaAsset(placeholderId);
      if (placeholderSrc) {
        for (const it of stateRef.current.items) {
          if (it.src === placeholderSrc) commands.removeItem(it.id);
        }
      }
      throw err;
    }
  }, [commands, startAssetTranscription]);
  const useTemplateAI = useCallback((tpl: Tpl) => {
    setChatCollapsed(false);
    setChatSeed({ text: t('参考模板「{name}」，用 create_motion_graphic 生成一个类似风格的动画： @{name} ', { name: tpl.name }), nonce: Date.now(), reference: { id: tpl.id, name: tpl.name, kind: 'template' } });
  }, [setChatCollapsed, t]);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

  // Export: POST the current timeline to the dev-server /export endpoint (which
  // renders it in headless Chrome via @remotion/renderer) and download the MP4.
  const [exportOpen, setExportOpen] = useState(false);
  // 导出走设置对话框，共 5 个 tab:视频/音频/MG动画/字幕/XML。
  const onExport = useCallback(() => setExportOpen(true), []);
  useEditorActions({
    commands,
    docRef,
    fps: state.fps,
    projectId: project.id,
    timelineRef: shortcutApiRef,
    openExport: onExport,
    openDesign: () => setShowDesign(true),
    openHistory: () => setShowVersions(true),
    openShortcuts: () => setShowShortcuts(true),
    toggleLayout: () => setChatCollapsed((value) => !value),
    focusAgent: () => {
      setChatCollapsed(false);
      requestAnimationFrame(() => {
        document.querySelector<HTMLTextAreaElement>('[data-cc-chat-composer]')?.focus();
      });
    },
  });

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `${chatCollapsed ? 46 : chatW}px 0 ${libW}px 0 minmax(0, 1fr)`,
        gridTemplateRows: `${HEADER_H}px minmax(0, 1fr) 0 ${timelineH}px`,
        height: '100vh',
        overflow: 'hidden',
        background: theme.bg,
        color: theme.text,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <TopBar
        projectName={project.name}

        canUndo={canUndo}
        canRedo={canRedo}
        onHome={onHome}
        onRename={onRename}
      />
      {exportOpen && (
        <ExportDialog state={state} projectName={project.name} onClose={() => setExportOpen(false)} />
      )}

      {showDesign && (
        <DesignStylePanel style={doc.designStyle} onApply={commands.setDesignStyle} onClose={() => setShowDesign(false)} />
      )}

      {showVersions && (
        <VersionHistory projectId={project.id} currentDoc={doc}
          onRestore={(d) => { commands.applyDoc(d); setShowVersions(false); }}
          onClose={() => setShowVersions(false)} />
      )}

      {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}

      <ChatPanel ctx={agentCtx} projectId={project.id} collapsed={chatCollapsed} onToggleCollapse={() => setChatCollapsed((v) => !v)} onPreviewState={setPreviewState} seed={chatSeed} creativeMode={creativeMode} onCreativeModeChange={changeCreativeMode} onImportMedia={importToPool} />

      <div style={{ gridColumn: 2, gridRow: '2 / 5' }}>
        {!chatCollapsed && <Divider onResize={(dx) => setChatW((w) => clamp(w + dx, CHAT_MIN_W, Math.max(CHAT_MIN_W, viewportW - libW - CANVAS_MIN_W - SPLITTER_TOTAL_W)))} />}
      </div>

      <div style={{ gridColumn: 3, gridRow: 2, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        <LibraryPanel semanticScopeId={project.id} templates={allTemplates} transitions={state.transitions ?? []} fxDefs={state.fxDefs ?? {}} onAddTemplate={addTemplate} onAddAudio={(a) => commands.addAudio(a)} playerRef={playerRef} fps={state.fps} items={state.items} trackOptions={trackOptions} captionTracks={captionTracks} onSetCaptions={commands.setCaptions} onUpdateCaptions={commands.updateCaptions} onSetItemTranscript={commands.setItemTranscript} onToggleWord={commands.toggleWord} onCleanScript={commands.cleanScript} onSetGapCap={commands.setGapCap} onSetTranscriptPlayOrder={commands.setTranscriptPlayOrder} onReorderTrackItems={commands.reorderTrackItems} onClearEdits={commands.clearEdits} assets={state.assets ?? []} mediaFolders={doc.mediaFolders} onImportMedia={importToPool} onImportMobileMedia={importMobileUpload} onAddMediaItem={(asset) => commands.addMediaItem(asset)} onCreateMediaFolder={commands.createMediaFolder} onRenameMediaFolder={commands.renameMediaFolder} onDeleteMediaFolder={commands.deleteMediaFolder} onMoveMediaAssets={commands.moveMediaAssets} onRenameMediaAsset={commands.renameMediaAsset} onSetMediaAssetFavorite={commands.setMediaAssetFavorite} onRemoveMediaAsset={commands.removeMediaAsset}
          onRelinkMediaAsset={(id, next) => commands.relinkMediaAsset(id, next)}
          onAddSolid={() => commands.addSolidItem({ startFrame: getPlayhead() })}
          onUseTemplateAI={useTemplateAI}
          selectedItem={selectedItem}
          onApplyTransition={(type, custom) => state.selectedId && commands.addTransition(state.selectedId, type, undefined, custom)}
          onApplyFx={(assetId) => {
            if (!state.selectedId) return;
            const it = state.items.find((x) => x.id === state.selectedId);
            if (!it) return;
            const prev = it.effects ?? [];
            const next = [
              ...prev.filter((e) => e.assetId !== assetId),
              { id: `fx_${assetId}`, assetId, overrides: {} },
            ];
            commands.setItemEffects(state.selectedId, next, serializableDefsFor(next));
          }}
          onApplyZoom={(zoom) => state.selectedId && commands.setItemZoom(state.selectedId, zoom)}
          onApplyAudioFx={async (audioFxId) => {
            const id = state.selectedId;
            const item = id ? state.items.find((it) => it.id === id) : null;
            if (!item || (item.kind !== 'video' && item.kind !== 'audio')) {
              showAppToast(t('人声隔离只能用在视频 / 音频片段上'), { error: true });
              return;
            }
            showAppToast(t('人声隔离处理中…'), { ms: 60_000 });
            try {
              const strength = strengthFromAudioFxId(audioFxId);
              const r = await isolateVoiceOnSrc(item.src ?? '', strength, { force: true });
              commands.setItemDenoise(item.id, r.path, r.strength);
              showAppToast(t('人声隔离已应用'));
            } catch (err) {
              showAppToast(err instanceof Error ? err.message : t('人声隔离失败'), { error: true });
            }
          }}
 />
      </div>
      <div style={{ gridColumn: 4, gridRow: 2 }}>
        <Divider onResize={(dx) => setLibW((w) => clamp(w + dx, ASSETS_MIN_W, Math.max(ASSETS_MIN_W, viewportW - (chatCollapsed ? 46 : chatW) - CANVAS_MIN_W - SPLITTER_TOTAL_W)))} />
      </div>
      <div style={{ gridColumn: 5, gridRow: 2, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        <PreviewPanel state={autoGradePreviewState ?? previewState ?? state} playerRef={playerRef} onImport={importToCanvas}
          onUpdateCaptions={previewState || autoGradePreviewState ? undefined : commands.updateCaptions}
          onSeedChat={(text) => setChatSeed({ text, nonce: Date.now() })} />
        {selectedItem && (
          <InspectorPanel
            templates={allTemplates}
            selectedItem={selectedItem}
            fps={state.fps}
            onItemPropChange={(key, value) => state.selectedId && commands.updateItemProps(state.selectedId, { [key]: value })}
            onItemVolumeChange={(v) => state.selectedId && commands.setItemVolume(state.selectedId, v)}
            onItemFadeChange={(fade) => state.selectedId && commands.setItemFade(state.selectedId, fade)}
            onItemTransformChange={(patch) => state.selectedId && commands.setItemTransform(state.selectedId, patch)}
            onItemFiltersChange={(patch) => {
              if (autoGradeBusy || autoGradeSession) cancelAutoGrade();
              if (state.selectedId) commands.setItemFilters(state.selectedId, patch);
            }}
            autoGrade={{
              busy: autoGradeBusy,
              targetCount: autoGradeTargets.length,
              previewCount: autoGradeSession?.recommendations.length ?? 0,
              failedCount: autoGradeSession?.failedCount ?? 0,
              selectedPreview: selectedAutoGrade ? {
                filters: selectedAutoGrade.analysis.filters,
                bitDepth: selectedAutoGrade.analysis.profile.bitDepth,
                hdr: selectedAutoGrade.analysis.profile.hdr,
              } : null,
              onAnalyze: analyzeSelectedColor,
              onApply: applyAutoGrade,
              onCancel: cancelAutoGrade,
            }}
            onItemZoomChange={(patch) => state.selectedId && commands.setItemZoom(state.selectedId, patch)}
            onItemEffectsChange={(effects) => state.selectedId && commands.setItemEffects(state.selectedId, effects)}
            onItemSpeedChange={(rate) => state.selectedId && commands.setItemSpeed(state.selectedId, rate)}
            onNormalizeLoudness={async () => {
              const id = state.selectedId;
              const item = id ? state.items.find((it) => it.id === id) : null;
              if (!item?.src || item.kind !== 'audio') return;
              const lufs = await analyzeClipLoudness(item.src);
              commands.setItemVolume(item.id, gainForTarget(lufs, -14));
            }}
            onIsolateVoice={async (action, strength) => {
              const id = state.selectedId;
              const item = id ? state.items.find((it) => it.id === id) : null;
              if (!item || (item.kind !== 'video' && item.kind !== 'audio')) return;
              if (action === 'clear') {
                commands.setItemDenoise(item.id, null);
                return;
              }
              const r = await isolateVoiceOnSrc(
                item.src ?? '',
                typeof strength === 'number' ? strength : (item.denoiseStrength ?? 70),
                { force: true },
              );
              commands.setItemDenoise(item.id, r.path, r.strength);
            }}
            getPlayhead={getPlayhead}
            onSetReframeKeyframe={(frame, fx, fy, mag) => state.selectedId && commands.setReframeKeyframe(state.selectedId, frame, fx, fy, mag)}
            onRemoveReframeKeyframe={(frame) => state.selectedId && commands.removeReframeKeyframe(state.selectedId, frame)}
            onSetItemKeyframe={(prop, frame, value, easing) => state.selectedId && commands.setItemKeyframe(state.selectedId, prop, frame, value, easing)}
            onRemoveItemKeyframe={(prop, frame) => state.selectedId && commands.removeItemKeyframe(state.selectedId, prop, frame)}
            onSeek={(frame) => shortcutApiRef.current?.seekTo(frame)}
            transition={state.transitions?.find((t) => t.incomingItemId === state.selectedId) ?? null}
            onAddTransition={(type) => state.selectedId && commands.addTransition(state.selectedId, type)}
            onSetTransition={(patch) => {
              const t = state.transitions?.find((x) => x.incomingItemId === state.selectedId);
              if (t) commands.setTransition(t.id, patch);
            }}
            onRemoveTransition={() => {
              const t = state.transitions?.find((x) => x.incomingItemId === state.selectedId);
              if (t) commands.removeTransition(t.id);
            }}
          />
        )}
      </div>
      <div style={{ gridColumn: '3 / -1', gridRow: 3 }}>
        <Divider orientation="horizontal" onResize={(dy) => setTimelineH((h) => clamp(h - dy, TIMELINE_MIN_H, Math.max(TIMELINE_MIN_H, viewportH - HEADER_H - 300)))} />
      </div>
      <div style={{ gridColumn: '3 / -1', gridRow: 4, display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        <TimelineTabs doc={doc} commands={commands} />
        <Timeline state={state} commands={commands} playerRef={playerRef}
          projectId={project.id}
          shortcutApiRef={shortcutApiRef}
          onRecordVoiceover={async (blob) => {
            const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
            const asset = await importMedia(new File([blob], `旁白.${ext}`, { type: blob.type }), state.fps);
            ingestToPool(asset); // 旁白 auto-transcribes; the placed A1 clip backfills on completion
            commands.addMediaItem(asset, { track: 'A1', startFrame: getPlayhead() });
          }} />
      </div>
      <AppToastHost />
    </div>
  );
}
