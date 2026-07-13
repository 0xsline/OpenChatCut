import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PlayerRef } from '@remotion/player';
import { theme } from './theme';
import { TopBar } from './components/TopBar';
import { ChatPanel } from './components/ChatPanel';
import { LibraryPanel } from './components/LibraryPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { InspectorPanel } from './components/InspectorPanel';
import { Timeline } from './components/Timeline';
import { useEditor } from './editor/store';
import type { TimelineState } from './editor/types';
import templatesJson from './chatcut-templates.json';
import type { Tpl } from './types';
import { AUDIO_ASSETS } from './audio/library';

const TEMPLATES = templatesJson as Tpl[];

const pick = (name: string): Tpl => TEMPLATES.find((t) => t.name.includes(name)) ?? TEMPLATES[0];
const seedItem = (id: string, tpl: Tpl, startFrame: number) => ({
  id, track: 'V1' as const, startFrame, durationInFrames: tpl.durationInFrames,
  kind: 'motion-graphic' as const, templateId: tpl.id, name: tpl.name,
  code: tpl.code, props: { ...tpl.props }, width: tpl.width, height: tpl.height,
});
const SEED_A = pick('Finance Explainer');
const SEED_B = pick('Dark Tech');
const INITIAL: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  items: [
    seedItem('seed_1', SEED_A, 0),
    seedItem('seed_2', SEED_B, SEED_A.durationInFrames),
  ],
  selectedId: 'seed_1',
};

export default function App() {
  const { state, commands, canUndo, canRedo } = useEditor(INITIAL);
  const selectedItem = state.items.find((it) => it.id === state.selectedId) ?? null;

  // keep a live ref of state so agent tools always read the latest timeline
  const stateRef = useRef(state);
  stateRef.current = state;
  const playerRef = useRef<PlayerRef | null>(null);
  const agentCtx = useMemo(
    () => ({ commands, getState: () => stateRef.current, templates: TEMPLATES, audio: AUDIO_ASSETS }),
    [commands],
  );

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
        gridTemplateColumns: '320px 1fr',
        gridTemplateRows: '48px minmax(0, 1fr)',
        height: '100vh',
        overflow: 'hidden',
        background: theme.bg,
        color: theme.text,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <TopBar
        projectName="Directus 选型与内部机制 (clone)"
        credits={18.5}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={commands.undo}
        onRedo={commands.redo}
        onExport={onExport}
        exporting={exporting}
      />

      <ChatPanel ctx={agentCtx} />

      <div
        style={{
          gridColumn: 2, gridRow: 2, display: 'grid',
          gridTemplateRows: 'minmax(0, 1fr) 300px',
          minHeight: 0, minWidth: 0, overflow: 'hidden',
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
          <LibraryPanel templates={TEMPLATES} onAddTemplate={(tpl) => commands.addMotionGraphic(tpl)} onAddAudio={(a) => commands.addAudio(a)} playerRef={playerRef} fps={state.fps} items={state.items} captions={state.captions ?? null} onSetCaptions={commands.setCaptions} onUpdateCaptions={commands.updateCaptions} />
          {/* right column: preview on top, inspector below */}
          <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
            <PreviewPanel state={state} playerRef={playerRef} />
            <InspectorPanel
              templates={TEMPLATES}
              selectedItem={selectedItem}
              onItemPropChange={(key, value) => state.selectedId && commands.updateItemProps(state.selectedId, { [key]: value })}
            />
          </div>
        </div>
        <Timeline state={state} commands={commands} playerRef={playerRef} />
      </div>
    </div>
  );
}
