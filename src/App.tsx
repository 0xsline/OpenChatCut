import { useCallback, useEffect, useState } from 'react';
import { theme } from './theme';
import Editor from './Editor';
import { Dashboard } from './components/Dashboard';
import { INITIAL } from './editor/initial';
import {
  listProjects, loadProject, createProject, renameProject, duplicateProject, deleteProject,
  randomProjectName, docFromTimeline, type ProjectMeta,
} from './persist/projectStore';
import type { ProjectDoc, TimelineState } from './editor/types';

// A brand-new project starts empty; the first-run "示例工程" gets the seed clips.
const emptyState = (): TimelineState => ({ ...INITIAL, items: [], selectedId: null });
const emptyDoc = (): ProjectDoc => docFromTimeline(emptyState());
const seedDoc = (): ProjectDoc => docFromTimeline(INITIAL);

type Route = { name: 'dashboard' } | { name: 'editor'; id: string };
function parseHash(): Route {
  const m = window.location.hash.match(/^#\/editor\/(.+)$/);
  return m ? { name: 'editor', id: m[1] } : { name: 'dashboard' };
}
const go = (hash: string) => { window.location.hash = hash; };

function Splash({ text }: { text: string }) {
  return (
    <div style={{ height: '100vh', display: 'grid', placeItems: 'center', background: theme.bg, color: theme.textDim, fontFamily: 'system-ui, sans-serif', fontSize: 13 }}>
      {text}
    </div>
  );
}

// Load one project's timeline, then mount the editor for it.
function EditorLoader({ meta, onHome, onRename }: { meta: ProjectMeta; onHome: () => void; onRename: (name: string) => void }) {
  const [initial, setInitial] = useState<ProjectDoc | null>(null);
  useEffect(() => {
    let alive = true;
    loadProject(meta.id).then((d) => { if (alive) setInitial(d ?? emptyDoc()); });
    return () => { alive = false; };
  }, [meta.id]);
  if (!initial) return <Splash text="加载工程…" />;
  return <Editor initial={initial} project={meta} onHome={onHome} onRename={onRename} />;
}

export default function App() {
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [route, setRoute] = useState<Route>(parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const refresh = useCallback(async () => { setProjects(await listProjects()); }, []);

  useEffect(() => {
    (async () => {
      let list = await listProjects();
      if (list.length === 0) list = [await createProject('示例工程', seedDoc())];
      setProjects(list);
    })();
  }, []);

  if (!projects) return <Splash text="加载中…" />;

  if (route.name === 'editor') {
    const meta = projects.find((p) => p.id === route.id);
    if (!meta) { go('#/'); return <Splash text="工程不存在，返回…" />; }
    return (
      <EditorLoader
        key={meta.id}
        meta={meta}
        onHome={() => go('#/')}
        onRename={async (name) => { await renameProject(meta.id, name); refresh(); }}
      />
    );
  }

  return (
    <Dashboard
      projects={projects}
      onOpen={(id) => go(`#/editor/${id}`)}
      onNew={async () => { const m = await createProject(randomProjectName(), emptyDoc()); await refresh(); go(`#/editor/${m.id}`); }}
      onRename={async (id, name) => { await renameProject(id, name); refresh(); }}
      onDuplicate={async (id) => { await duplicateProject(id); refresh(); }}
      onDelete={async (id) => { await deleteProject(id); refresh(); }}
    />
  );
}
