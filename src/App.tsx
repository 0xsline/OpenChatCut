import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { theme } from './theme';
import { Dashboard } from './components/Dashboard';
import {
  listProjects, loadProject, createProject, renameProject, duplicateProject,
  randomProjectName, docFromTimeline, hasProjectHistory, type ProjectMeta,
} from './persist/projectStore';
import type { ProjectDoc, TimelineState } from './editor/types';
import { applyProjectImport, buildProjectExport, parseProjectEnvelope } from './persist/projectTransfer';
import { purgeProjectCascade } from './persist/mediaCleanup';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from './agent/capabilities';
import { applyAgentModelStatus } from './agent/model-selection';
import { useT } from './i18n/locale';

const Editor = lazy(() => import('./Editor'));

// A brand-new project starts empty; the first-run "Sample Project" gets the seed clips.
const emptyState = (): TimelineState => ({
  fps: 30,
  width: 1920,
  height: 1080,
  items: [],
  selectedId: null,
  trackOrder: ['track_v1'],
  tracks: { track_v1: { kind: 'video' } },
});
const emptyDoc = (): ProjectDoc => docFromTimeline(emptyState());
const seedDoc = async (): Promise<ProjectDoc> => docFromTimeline((await import('./editor/initial')).INITIAL);

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
  const t = useT();
  const [initial, setInitial] = useState<ProjectDoc | null>(null);
  useEffect(() => {
    let alive = true;
    loadProject(meta.id).then((d) => { if (alive) setInitial(d ?? emptyDoc()); });
    return () => { alive = false; };
  }, [meta.id]);
  if (!initial) return <Splash text={t('Load project…')} />;
  return <Suspense fallback={<Splash text={t('Loading editor…')} />}><Editor initial={initial} project={meta} onHome={onHome} onRename={onRename} /></Suspense>;
}

export default function App() {
  const t = useT();
  const [projects, setProjects] = useState<ProjectMeta[] | null>(null);
  const [route, setRoute] = useState<Route>(parseHash());

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Sync the agent's capability manifest with the server's live key state (corrects the
  // build-time __CONFIGURED_CAPS__ snapshot after any key edited in a prior session).
  // keys (booleans only) refine the manifest to vendor granularity.
  useEffect(() => {
    fetch('/api/keys')
      .then((r) => r.json() as Promise<{ caps?: Record<string, boolean>; keys?: Record<string, { configured: boolean }>; models?: Record<string, string> }>)
      .then((d) => {
        if (d?.caps) applyLiveCaps(d.caps);
        if (d?.keys) applyLiveKeyStatus(d.keys);
        if (d?.models) {
          applyLiveModels(d.models);              // per-vendor models + PREFERRED_* routing
          applyAgentModelStatus(d.keys ?? {}, d.models);
        }
      })
      .catch(() => { /* dev endpoint absent (e.g. preview build) — keep the define snapshot */ });
  }, []);

  const refresh = useCallback(async () => { setProjects(await listProjects()); }, []);

  useEffect(() => {
    (async () => {
      let list = await listProjects();
      if (list.length === 0 && !(await hasProjectHistory())) {
        list = [await createProject('Sample project', await seedDoc())];
      }
      setProjects(list);
    })();
  }, []);

  if (!projects) return <Splash text={t('Loading…')} />;

  if (route.name === 'editor') {
    const meta = projects.find((p) => p.id === route.id);
    if (!meta) { go('#/'); return <Splash text={t('The project does not exist, return...')} />; }
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
      onDelete={async (id) => { await purgeProjectCascade(id); refresh(); }}  // Cascade: delete the project + clear its exclusive materials
      onExport={async (id, name) => {
        const r = await buildProjectExport(id, name);
        downloadBlob(r.blob, r.filename);
        return r.mediaMissing.length
          ? t('Exported "{name}」;{n} Both ends of the material cannot be obtained,Not included in the package', { name, n: r.mediaMissing.length })
          : t('Exported "{name}」(Contains {n} materials)', { name, n: r.mediaTotal });
      }}
      onImport={async (file) => {
        const parsed = parseProjectEnvelope(await file.text());
        if ('error' in parsed) return t('Import failed:{error}', { error: parsed.error });
        const r = await applyProjectImport(parsed.envelope);
        await refresh();
        return r.mediaMissing.length
          ? t('Imported "{name}」;missing {n} materials({list})', { name: r.meta.name, n: r.mediaMissing.length, list: r.mediaMissing.map((s: string) => s.split('/').pop()).join('、') })
          : t('Imported "{name}」(Material {a}/{b})', { name: r.meta.name, a: r.mediaRestored, b: r.mediaTotal });
      }}
    />
  );
}

// Blob download: Synchronous revoke will interrupt the Chrome download (plug-in export is ignored), and DOM + delayed recycling must be installed.
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
