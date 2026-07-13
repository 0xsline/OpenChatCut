import { useEffect, useState } from 'react';
import { theme } from './theme';
import Editor from './Editor';
import { INITIAL } from './editor/initial';
import { loadProject } from './persist/projectStore';
import type { TimelineState } from './editor/types';

// Load the persisted project from IndexedDB before mounting the editor (so we
// don't flash the seed project then swap). First run has nothing saved → INITIAL.
export default function App() {
  const [initial, setInitial] = useState<TimelineState | null>(null);

  useEffect(() => {
    let alive = true;
    loadProject().then((saved) => { if (alive) setInitial(saved ?? INITIAL); });
    return () => { alive = false; };
  }, []);

  if (!initial) {
    return (
      <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: theme.bg, color: theme.textDim, fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
        加载工程…
      </div>
    );
  }
  return <Editor initial={initial} />;
}
