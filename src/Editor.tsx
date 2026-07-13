import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from './theme';
import { TopBar } from './components/TopBar';
import { ChatPanel } from './components/ChatPanel';
import { LibraryPanel } from './components/LibraryPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { InspectorPanel } from './components/InspectorPanel';
import { Timeline } from './components/Timeline';
import { Divider } from './components/Divider';
import { usePersistedState } from './hooks/usePersistedState';
import { useEditor } from './editor/store';
import type { TimelineState } from './editor/types';
import { TEMPLATES } from './editor/initial';
import { saveProject, type ProjectMeta } from './persist/projectStore';
import { importMedia } from './media/upload';
import { AUDIO_ASSETS } from './audio/library';

interface EditorProps {
  initial: TimelineState;
  project: ProjectMeta;
  onHome: () => void;
  onRename: (name: string) => void;
}

export default function Editor({ initial, project, onHome, onRename }: EditorProps) {
  const { state, commands, canUndo, canRedo } = useEditor(initial);
  const selectedItem = state.items.find((it) => it.id === state.selectedId) ?? null;

  // keep a live ref of state so agent tools always read the latest timeline
  const stateRef = useRef(state);
  stateRef.current = state;
  const playerRef = useRef<PlayerRef | null>(null);
  const agentCtx = useMemo(
    () => ({ commands, getState: () => stateRef.current, templates: TEMPLATES, audio: AUDIO_ASSETS }),
    [commands],
  );

  // current playhead frame, synced from the Remotion Player (shared by the
  // timeline's playhead line + the inspector's keyframe-at-playhead controls).
  const [playhead, setPlayhead] = useState(0);
  useEffect(() => {
    let raf = 0;
    let detach: (() => void) | null = null;
    const attach = () => {
      const p = playerRef.current;
      if (!p) { raf = requestAnimationFrame(attach); return; }
      const onFrame = (e: { detail: { frame: number } }) => setPlayhead(e.detail.frame);
      p.addEventListener('frameupdate', onFrame);
      detach = () => p.removeEventListener('frameupdate', onFrame);
    };
    attach();
    return () => { if (raf) cancelAnimationFrame(raf); detach?.(); };
  }, []);

  // autosave this project to IndexedDB (debounced) so a reload restores the timeline
  useEffect(() => {
    const id = setTimeout(() => saveProject(project.id, state), 500);
    return () => clearTimeout(id);
  }, [state, project.id]);

  // resizable / collapsible panels (persisted across refreshes)
  const [chatW, setChatW] = usePersistedState('cc.chatW', 300);
  const [libW, setLibW] = usePersistedState('cc.libW', 360);
  const [timelineH, setTimelineH] = usePersistedState('cc.timelineH', 224);
  const [chatCollapsed, setChatCollapsed] = usePersistedState('cc.chatCollapsed', false);
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
        gridTemplateColumns: `${chatCollapsed ? 46 : chatW}px 5px 1fr`,
        gridTemplateRows: '48px minmax(0, 1fr)',
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
      />

      <ChatPanel ctx={agentCtx} collapsed={chatCollapsed} onToggleCollapse={() => setChatCollapsed((v) => !v)} />

      <div style={{ gridColumn: 2, gridRow: 2 }}>
        {!chatCollapsed && <Divider onResize={(dx) => setChatW((w) => clamp(w + dx, 220, 520))} />}
      </div>

      <div
        style={{
          gridColumn: 3, gridRow: 2, display: 'grid',
          gridTemplateRows: `minmax(0, 1fr) 5px ${timelineH}px`,
          minHeight: 0, minWidth: 0, overflow: 'hidden',
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: `${libW}px 5px 1fr`, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
          <LibraryPanel templates={TEMPLATES} onAddTemplate={(tpl) => commands.addMotionGraphic(tpl)} onAddAudio={(a) => commands.addAudio(a)} playerRef={playerRef} fps={state.fps} items={state.items} captions={state.captions ?? null} onSetCaptions={commands.setCaptions} onUpdateCaptions={commands.updateCaptions} onSetItemTranscript={commands.setItemTranscript} onToggleWord={commands.toggleWord} onCleanScript={commands.cleanScript} onClearEdits={commands.clearEdits} assets={state.assets ?? []} onImportMedia={async (file) => { commands.addAsset(await importMedia(file, state.fps)); }} onAddMediaItem={(asset) => commands.addMediaItem(asset)} />
          <Divider onResize={(dx) => setLibW((w) => clamp(w + dx, 260, 640))} />
          {/* right column: preview on top, inspector below */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
            <PreviewPanel state={state} playerRef={playerRef} onSetAspect={commands.setAspect} />
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
              playhead={playhead}
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
          </div>
        </div>
        <Divider orientation="horizontal" onResize={(dy) => setTimelineH((h) => clamp(h - dy, 120, 300))} />
        <Timeline state={state} commands={commands} playerRef={playerRef} playhead={playhead} setPlayhead={setPlayhead} />
      </div>
    </div>
  );
}
