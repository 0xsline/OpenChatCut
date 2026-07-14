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
import { importMedia } from './media/upload';
import { AUDIO_ASSETS } from './audio/library';
import type { Tpl } from './types';
import type { AgentReference } from './agent/context';

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
    () => ({ commands, getState: () => stateRef.current, getDoc: () => docRef.current, getCreativeMode: () => creativeModeRef.current, templates: TEMPLATES, audio: AUDIO_ASSETS }),
    [commands],
  );

  // a pending proposal's draft result, previewed in the player (null = committed)
  const [previewState, setPreviewState] = useState<TimelineState | null>(null);
  // library「用 AI 生成」→ prefill the chat composer (nonce forces re-seed of the same text)
  const [chatSeed, setChatSeed] = useState<{ text: string; nonce: number; reference?: AgentReference } | null>(null);
  // 设计风格(品牌)编辑器弹窗 (source manage_design_style)
  const [showDesign, setShowDesign] = useState(false);
  // 版本历史弹窗 (source /api/versions)
  const [showVersions, setShowVersions] = useState(false);

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
  const importToPool = useCallback(async (file: File) => {
    commands.addAsset(await importMedia(file, stateRef.current.fps));
  }, [commands]);
  const importToCanvas = useCallback(async (file: File) => {
    const asset = await importMedia(file, stateRef.current.fps);
    commands.addAsset(asset);
    commands.addMediaItem(asset);
  }, [commands]);
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

  // keyboard: delete selected, undo/redo
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && state.selectedId) {
        e.preventDefault();
        commands.removeItem(state.selectedId);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? commands.redo() : commands.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state.selectedId, commands]);

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
        credits={18.5}
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

      <ChatPanel ctx={agentCtx} projectId={project.id} collapsed={chatCollapsed} onToggleCollapse={() => setChatCollapsed((v) => !v)} onPreviewState={setPreviewState} seed={chatSeed} creativeMode={creativeMode} onCreativeModeChange={changeCreativeMode} />

      <div style={{ gridColumn: 2, gridRow: '2 / 5' }}>
        {!chatCollapsed && <Divider onResize={(dx) => setChatW((w) => clamp(w + dx, CHAT_MIN_W, Math.max(CHAT_MIN_W, viewportW - libW - CANVAS_MIN_W - SPLITTER_TOTAL_W)))} />}
      </div>

      <div style={{ gridColumn: 3, gridRow: 2, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        <LibraryPanel templates={TEMPLATES} onAddTemplate={addTemplate} onAddAudio={(a) => commands.addAudio(a)} playerRef={playerRef} fps={state.fps} items={state.items} trackOptions={trackOptions} captions={state.captions ?? null} onSetCaptions={commands.setCaptions} onUpdateCaptions={commands.updateCaptions} onSetItemTranscript={commands.setItemTranscript} onToggleWord={commands.toggleWord} onCleanScript={commands.cleanScript} onClearEdits={commands.clearEdits} assets={state.assets ?? []} mediaFolders={doc.mediaFolders} onImportMedia={importToPool} onAddMediaItem={(asset) => commands.addMediaItem(asset)} onCreateMediaFolder={commands.createMediaFolder} onRenameMediaFolder={commands.renameMediaFolder} onDeleteMediaFolder={commands.deleteMediaFolder} onMoveMediaAssets={commands.moveMediaAssets} onRenameMediaAsset={commands.renameMediaAsset} onSetMediaAssetFavorite={commands.setMediaAssetFavorite} onUseTemplateAI={useTemplateAI}
          selectedItem={selectedItem}
          onApplyTransition={(type) => state.selectedId && commands.addTransition(state.selectedId, type)}
          onApplyFx={(assetId) => state.selectedId && commands.setItemEffects(state.selectedId, [{ id: `fx_${assetId}`, assetId, overrides: {} }])}
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
          onRecordVoiceover={async (blob) => {
            const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
            const asset = await importMedia(new File([blob], `旁白.${ext}`, { type: blob.type }), state.fps);
            commands.addAsset(asset);
            commands.addMediaItem(asset, { track: 'A1', startFrame: getPlayhead() });
          }} />
      </div>
    </div>
  );
}
