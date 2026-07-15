import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from './theme';
import { TopBar } from './components/TopBar';
import { ChatPanel } from './components/ChatPanel';
import { LibraryPanel } from './library/LibraryPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { InspectorPanel } from './components/InspectorPanel';
import { Timeline } from './components/Timeline';
import { TimelineTabs } from './components/TimelineTabs';
import { Divider } from './components/Divider';
import { DesignStylePanel } from './components/DesignStylePanel';
import { VersionHistory } from './components/VersionHistory';
import { usePersistedState } from './hooks/usePersistedState';
import { useEditor } from './editor/store';
import type { ProjectDoc, TimelineState } from './editor/types';
import { timelineTrackIds, trackAlias, trackKind } from './editor/types';
import { TEMPLATES } from './editor/initial';
import { saveProject, loadCreativeMode, saveCreativeMode, type ProjectMeta } from './persist/projectStore';
import { saveVersion } from './persist/versionStore';
import { importMedia } from './media/upload';
import { enqueueTranscription, shouldTranscribe } from './transcript/transcribe-jobs';
import type { MediaAsset } from './editor/types';
import { AUDIO_ASSETS } from './audio/library';
import type { Tpl } from './types';
import type { AgentReference } from './agent/context';
import { useShortcutDispatcher } from './shortcuts/useShortcutDispatcher';
import type { TimelineShortcutApi } from './shortcuts/timelineApi';
import { ShortcutsDialog } from './shortcuts/ShortcutsDialog';

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
const SOURCE_VIEWPORT_W = 1463;
const SOURCE_CONTENT_H = 761;

export default function Editor({ initial, project, onHome, onRename }: EditorProps) {
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

  // keep live refs so agent tools always read the latest timeline/project
  const stateRef = useRef(state);
  stateRef.current = state;
  const docRef = useRef(doc);
  docRef.current = doc;
  // 创作模式(source agent_skill):选中的技能 id,注入系统提示;存 IDB(不进 undo 历史)
  const [creativeMode, setCreativeMode] = useState<string | null>(null);
  const creativeModeRef = useRef(creativeMode);
  creativeModeRef.current = creativeMode;
  useEffect(() => { loadCreativeMode(project.id).then(setCreativeMode); }, [project.id]);
  const changeCreativeMode = useCallback((id: string | null) => {
    setCreativeMode(id);
    saveCreativeMode(project.id, id);
  }, [project.id]);
  const playerRef = useRef<PlayerRef | null>(null);
  const agentCtx = useMemo(
    () => ({
      commands,
      getState: () => stateRef.current,
      getDoc: () => docRef.current,
      getCreativeMode: () => creativeModeRef.current,
      templates: TEMPLATES,
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
    [commands, project.id, onRename],
  );

  // a pending proposal's draft result, previewed in the player (null = committed)
  const [previewState, setPreviewState] = useState<TimelineState | null>(null);
  // library「用 AI 生成」→ prefill the chat composer (nonce forces re-seed of the same text)
  const [chatSeed, setChatSeed] = useState<{ text: string; nonce: number; reference?: AgentReference } | null>(null);
  // 设计风格(品牌)编辑器弹窗 (source manage_design_style)
  const [showDesign, setShowDesign] = useState(false);
  // 版本历史弹窗 (source /api/versions)
  const [showVersions, setShowVersions] = useState(false);
  // 快捷键帮助 (source Mod+Alt+K)
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

  // Switching timelines: seek the shared Player so it doesn't show a stale frame.
  useEffect(() => {
    playerRef.current?.seekTo(0);
  }, [doc.activeTimelineId]);

  // Source Dockview geometry measured at 1463 x 802 CSS px.
  const viewportW = typeof window === 'undefined' ? 1440 : window.innerWidth;
  const viewportH = typeof window === 'undefined' ? 900 : window.innerHeight;
  const [chatW, setChatW] = usePersistedState('cc.chatW.source-ui-v7', Math.max(CHAT_MIN_W, Math.round(viewportW * 356 / SOURCE_VIEWPORT_W)));
  const [libW, setLibW] = usePersistedState('cc.libW.source-ui-v7', Math.max(ASSETS_MIN_W, Math.round(viewportW * 406 / SOURCE_VIEWPORT_W)));
  const [timelineH, setTimelineH] = usePersistedState('cc.timelineH.source-ui-v7', Math.max(TIMELINE_MIN_H, Math.round((viewportH - HEADER_H) * 350 / SOURCE_CONTENT_H)));
  const [chatCollapsed, setChatCollapsed] = usePersistedState('cc.chatCollapsed', false);
  const addTemplate = useCallback((tpl: Tpl) => commands.addMotionGraphic(tpl), [commands]);
  // Add an asset to the pool AND kick off "上传即转写" ASR for audio-bearing media.
  // On completion the transcript is written onto the asset (so later placements inherit
  // it) and backfilled onto any clip already placed from this asset (drag-to-canvas /
  // voiceover), so the口播 is editable as soon as ASR lands.
  const ingestToPool = useCallback((asset: MediaAsset) => {
    commands.addAsset(shouldTranscribe(asset.kind) ? { ...asset, transcribeStatus: 'running' } : asset);
    if (!shouldTranscribe(asset.kind)) return;
    enqueueTranscription(asset, {
      onComplete: (job) => {
        if (job.status === 'done' && job.words?.length) {
          commands.setAssetTranscription(asset.id, { transcript: job.words, transcribeStatus: 'done', transcribeError: undefined });
          for (const it of stateRef.current.items) {
            if (it.src === asset.src && !(it.transcript?.length)) commands.setItemTranscript(it.id, job.words);
          }
        } else if (job.status === 'failed') {
          commands.setAssetTranscription(asset.id, { transcribeStatus: 'failed', transcribeError: job.error });
        }
      },
    });
  }, [commands]);
  const importToPool = useCallback(async (file: File) => {
    const asset = await importMedia(file, stateRef.current.fps);
    ingestToPool(asset);
    return asset;
  }, [ingestToPool]);
  const importToCanvas = useCallback(async (file: File) => {
    const asset = await importMedia(file, stateRef.current.fps);
    ingestToPool(asset);
    commands.addMediaItem(asset);
  }, [commands, ingestToPool]);
  const useTemplateAI = useCallback((tpl: Tpl) => {
    setChatCollapsed(false);
    setChatSeed({ text: `参考模板「${tpl.name}」，用 create_motion_graphic 生成一个类似风格的动画： @${tpl.name} `, nonce: Date.now(), reference: { id: tpl.id, name: tpl.name, kind: 'template' } });
  }, [setChatCollapsed]);
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

  // Export: POST the current timeline to the dev-server /export endpoint (which
  // renders it in headless Chrome via @remotion/renderer) and download the MP4.
  const [exporting, setExporting] = useState(false);
  const onExport = useCallback(async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch('/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: stateRef.current }),
      });
      if (!res.ok) {
        const info = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(info?.error ?? `导出失败 (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'export.mp4';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : '导出失败');
    } finally {
      setExporting(false);
    }
  }, [exporting]);

  // Global shortcut bus (source live-shortcuts / shortcut-dispatcher — 54 actions)
  const tl = () => shortcutApiRef.current;
  useShortcutDispatcher({
    'play-pause': () => tl()?.playPause(),
    'seek-back': () => { const a = tl(); if (a) a.seekTo(a.getPlayhead() - 1); },
    'seek-fwd': () => { const a = tl(); if (a) a.seekTo(a.getPlayhead() + 1); },
    'seek-back-sec': () => { const a = tl(); if (a) a.seekTo(a.getPlayhead() - state.fps); },
    'seek-fwd-sec': () => { const a = tl(); if (a) a.seekTo(a.getPlayhead() + state.fps); },
    'shuttle-back': () => tl()?.shuttle(-1),
    'shuttle-fwd': () => tl()?.shuttle(1),
    'shuttle-pause': () => tl()?.shuttle(0),
    'shuttle-jog-back': () => tl()?.shuttleJog(-1),
    'shuttle-jog-fwd': () => tl()?.shuttleJog(1),

    'undo': () => commands.undo(),
    'redo': () => commands.redo(),
    'copy': () => tl()?.copySelected(),
    'cut': () => tl()?.cutSelected(),
    'paste': () => tl()?.pasteClipboard(),
    'paste-effects': () => tl()?.pasteEffects(),
    'duplicate': () => tl()?.duplicateSelected(),
    'delete': ({ shift }) => tl()?.deleteSelected(shift),
    'split': () => tl()?.splitAtPlayhead(),
    'interaction-mode-selection': () => tl()?.setEditMode('selection'),
    'interaction-mode-trim': () => tl()?.setEditMode('trim'),
    'interaction-mode-blade': () => tl()?.setEditMode('blade'),
    'nudge-left': ({ shift }) => tl()?.nudgeSelected(-(shift ? 5 : 1)),
    'nudge-right': ({ shift }) => tl()?.nudgeSelected(shift ? 5 : 1),
    'trim-start': () => tl()?.trimSelectedToPlayhead('start'),
    'trim-end': () => tl()?.trimSelectedToPlayhead('end'),
    'select-all': () => commands.selectAll(),
    'select-after': () => tl()?.selectAfterPlayhead(),
    'move-up': () => tl()?.moveSelectedTrack(-1),
    'move-down': () => tl()?.moveSelectedTrack(1),
    'move-left-boundary': () => tl()?.moveSelectedToBoundary('left'),
    'move-right-boundary': () => tl()?.moveSelectedToBoundary('right'),
    'save-version': () => {
      const name = `版本 ${new Date().toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
      void saveVersion(project.id, name, docRef.current).then(() => setShowVersions(true));
    },

    'prev-edit': () => tl()?.gotoEdit(-1),
    'next-edit': () => tl()?.gotoEdit(1),
    'zone-in': () => tl()?.setZoneIn(),
    'zone-out': () => tl()?.setZoneOut(),
    'zone-clear': () => tl()?.clearZone(),
    'zone-clip': () => tl()?.zoneFromClip(),
    'zone-selection': () => tl()?.zoneFromSelection(),

    'marker-add': () => tl()?.addMarker(false),
    'marker-shortcut-add-and-open': () => tl()?.addMarker(true),
    'marker-modify-at-playhead': () => tl()?.modifyMarkerAtPlayhead(),
    'marker-delete-at-playhead': () => tl()?.deleteMarkerAtPlayhead(),
    'marker-prev': () => tl()?.gotoMarker(-1),
    'marker-next': () => tl()?.gotoMarker(1),

    'snapping': () => tl()?.toggleSnap(),
    'selection-mode': () => tl()?.setEditMode('selection'),
    'zoom-in': () => tl()?.zoomBy(1.4),
    'zoom-out': () => tl()?.zoomBy(1 / 1.4),
    'zoom-fit': () => tl()?.fitToView(),
    'fullscreen': () => tl()?.fullscreenTimeline(),
    'keyboard-shortcuts': () => setShowShortcuts(true),

    'ask-ai': () => {
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
        credits={null}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={commands.undo}
        onRedo={commands.redo}
        onExport={onExport}
        exporting={exporting}
        onHome={onHome}
        onRename={onRename}
        onToggleLayout={() => setChatCollapsed((v) => !v)}
        onDesignStyle={() => setShowDesign(true)}
        onHistory={() => setShowVersions(true)}
      />

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
        <LibraryPanel templates={TEMPLATES} onAddTemplate={addTemplate} onAddAudio={(a) => commands.addAudio(a)} playerRef={playerRef} fps={state.fps} items={state.items} trackOptions={trackOptions} captions={state.captions ?? null} onSetCaptions={commands.setCaptions} onUpdateCaptions={commands.updateCaptions} onSetItemTranscript={commands.setItemTranscript} onToggleWord={commands.toggleWord} onCleanScript={commands.cleanScript} onSetGapCap={commands.setGapCap} onSetTranscriptPlayOrder={commands.setTranscriptPlayOrder} onReorderTrackItems={commands.reorderTrackItems} onClearEdits={commands.clearEdits} assets={state.assets ?? []} mediaFolders={doc.mediaFolders} onImportMedia={importToPool} onAddMediaItem={(asset) => commands.addMediaItem(asset)} onCreateMediaFolder={commands.createMediaFolder} onRenameMediaFolder={commands.renameMediaFolder} onDeleteMediaFolder={commands.deleteMediaFolder} onMoveMediaAssets={commands.moveMediaAssets} onRenameMediaAsset={commands.renameMediaAsset} onSetMediaAssetFavorite={commands.setMediaAssetFavorite}
          onRelinkMediaAsset={(id, next) => commands.relinkMediaAsset(id, next)}
          onAddSolid={() => commands.addSolidItem({ startFrame: getPlayhead() })}
          onUseTemplateAI={useTemplateAI}
          selectedItem={selectedItem}
          onApplyTransition={(type) => state.selectedId && commands.addTransition(state.selectedId, type)}
          onApplyFx={(assetId) => {
            if (!state.selectedId) return;
            const it = state.items.find((x) => x.id === state.selectedId);
            if (!it) return;
            const prev = it.effects ?? [];
            const next = [
              ...prev.filter((e) => e.assetId !== assetId),
              { id: `fx_${assetId}`, assetId, overrides: {} },
            ];
            commands.setItemEffects(state.selectedId, next);
          }}
          onApplyZoom={(shape) => state.selectedId && commands.setItemZoom(state.selectedId, { shape, magnification: 1.5 })}
          onApplyIsolate={(id, src, strength) => commands.setItemDenoise(id, src, strength)}
          onClearIsolate={(id) => commands.setItemDenoise(id, null)} />
      </div>
      <div style={{ gridColumn: 4, gridRow: 2 }}>
        <Divider onResize={(dx) => setLibW((w) => clamp(w + dx, ASSETS_MIN_W, Math.max(ASSETS_MIN_W, viewportW - (chatCollapsed ? 46 : chatW) - CANVAS_MIN_W - SPLITTER_TOTAL_W)))} />
      </div>
      <div style={{ gridColumn: 5, gridRow: 2, display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        <PreviewPanel state={previewState ?? state} playerRef={playerRef} onImport={importToCanvas} />
        {selectedItem && (
          <InspectorPanel
            templates={TEMPLATES}
            selectedItem={selectedItem}
            fps={state.fps}
            onItemPropChange={(key, value) => state.selectedId && commands.updateItemProps(state.selectedId, { [key]: value })}
            onItemVolumeChange={(v) => state.selectedId && commands.setItemVolume(state.selectedId, v)}
            onItemFadeChange={(fade) => state.selectedId && commands.setItemFade(state.selectedId, fade)}
            onItemTransformChange={(patch) => state.selectedId && commands.setItemTransform(state.selectedId, patch)}
            onItemFiltersChange={(patch) => state.selectedId && commands.setItemFilters(state.selectedId, patch)}
            onItemZoomChange={(patch) => state.selectedId && commands.setItemZoom(state.selectedId, patch)}
            onItemEffectsChange={(effects) => state.selectedId && commands.setItemEffects(state.selectedId, effects)}
            getPlayhead={getPlayhead}
            onSetReframeKeyframe={(frame, fx, fy, mag) => state.selectedId && commands.setReframeKeyframe(state.selectedId, frame, fx, fy, mag)}
            onRemoveReframeKeyframe={(frame) => state.selectedId && commands.removeReframeKeyframe(state.selectedId, frame)}
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
          shortcutApiRef={shortcutApiRef}
          onRecordVoiceover={async (blob) => {
            const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
            const asset = await importMedia(new File([blob], `旁白.${ext}`, { type: blob.type }), state.fps);
            ingestToPool(asset); // 旁白 auto-transcribes; the placed A1 clip backfills on completion
            commands.addMediaItem(asset, { track: 'A1', startFrame: getPlayhead() });
          }} />
      </div>
    </div>
  );
}
