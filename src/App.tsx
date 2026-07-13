import { useState } from 'react';
import { theme } from './theme';
import { TopBar } from './components/TopBar';
import { ChatPanel } from './components/ChatPanel';
import { LibraryPanel } from './components/LibraryPanel';
import { PreviewPanel } from './components/PreviewPanel';
import { Timeline } from './components/Timeline';
import templatesJson from './chatcut-templates.json';
import type { Tpl } from './types';

const TEMPLATES = templatesJson as Tpl[];

// ChatCut editor layout (dockview later; static grid for now):
//   ┌──────────────── TopBar ─────────────────┐
//   │ AI chat │ Library     │ Preview          │
//   │ (left,  ├─────────────┴──────────────────┤
//   │  full)  │ Timeline (V2/V1/A1/A2)         │
export default function App() {
  const [idx, setIdx] = useState(0);
  const [props, setProps] = useState<Record<string, unknown>>(TEMPLATES[0].props);
  const t = TEMPLATES[idx];

  const pick = (i: number) => {
    setIdx(i);
    setProps(TEMPLATES[i].props);
  };
  const onPropChange = (key: string, value: unknown) =>
    setProps((s) => ({ ...s, [key]: value }));

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '320px 1fr',
        gridTemplateRows: '48px 1fr',
        height: '100vh',
        background: theme.bg,
        color: theme.text,
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}
    >
      <TopBar projectName="Directus 选型与内部机制 (clone)" credits={18.5} />

      <ChatPanel />

      {/* right of AI: library+preview on top, timeline on bottom */}
      <div
        style={{
          gridColumn: 2,
          gridRow: 2,
          display: 'grid',
          gridTemplateRows: '1fr 300px',
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: '440px 1fr', minHeight: 0 }}>
          <LibraryPanel
            templates={TEMPLATES}
            selectedIdx={idx}
            onSelect={pick}
            props={props}
            onPropChange={onPropChange}
          />
          <PreviewPanel template={t} props={props} />
        </div>
        <Timeline clip={t} />
      </div>
    </div>
  );
}
