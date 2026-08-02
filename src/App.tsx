import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { theme } from './theme';
import { Dashboard } from './components/Dashboard';
import {
  listProjects, loadProject, createProject, renameProject, duplicateProject,
  randomProjectName, docFromTimeline, hasProjectHistory, type ProjectMeta,
} from './persist/projectStore';
import type { ProjectDoc, TimelineState } from './editor/types';
import { buildProjectExport, importProjectPackage } from './persist/projectTransfer';
import { purgeProjectCascade } from './persist/mediaCleanup';
import { applyLiveCaps, applyLiveKeyStatus, applyLiveModels } from './agent/capabilities';
import { fetchCodexModels, fetchCodexStatus } from './agent/codex/client';
import { applyAgentModelStatus, applyCodexAgentStatus } from './agent/model-selection';
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

interface LiveAgentStatus {
  readonly caps?: Record<string, boolean>;
  readonly keys?: Record<string, { readonly configured: boolean }>;
  readonly models?: Record<string, string>;
}

async function syncAgentBackends(isActive: () => boolean): Promise<void> {
  const [keyResult, codexResult] = await Promise.allSettled([
    fetch('/api/keys').then(async (response): Promise<LiveAgentStatus> => {
      if (!response.ok) throw new Error('Agent key status is unavailable.');
      return response.json() as Promise<LiveAgentStatus>;
    }),
    fetchCodexStatus(),
  ]);
  if (!isActive()) return;
  let savedCodexModel: string | undefined;
  let savedCodexReasoningEffort: string | undefined;
  if (keyResult.status === 'fulfilled') {
    const { caps, keys, models } = keyResult.value;
    if (caps) applyLiveCaps(caps);
    if (keys) applyLiveKeyStatus(keys);
    if (models) {
      applyLiveModels(models);
      applyAgentModelStatus(keys ?? {}, models);
      savedCodexModel = models.CODEX_MODEL;
      savedCodexReasoningEffort = models.CODEX_REASONING_EFFORT;
    }
  }
  if (codexResult.status === 'fulfilled') {
    const modelResult = codexResult.value.account?.type === 'chatgpt'
      ? await fetchCodexModels().catch(() => null)
      : null;
    if (!isActive()) return;
    applyCodexAgentStatus(
      codexResult.value,
      savedCodexModel,
      savedCodexReasoningEffort,
      modelResult && !modelResult.error ? modelResult.models : [],
    );
  }
}

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
  if (!initial) return <Splash text={t('加载工程…')} />;
  return <Suspense fallback={<Splash text={t('加载编辑器…')} />}><Editor initial={initial} project={meta} onHome={onHome} onRename={onRename} /></Suspense>;
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

  // Resolve both server status channels before applying either one. API-backed settings
  // are applied first so cold-start backend selection cannot depend on response timing.
  useEffect(() => {
    let alive = true;
    void syncAgentBackends(() => alive);
    return () => { alive = false; };
  }, []);

  const refresh = useCallback(async () => { setProjects(await listProjects()); }, []);

  useEffect(() => {
    (async () => {
      let list = await listProjects();
      if (list.length === 0 && !(await hasProjectHistory())) {
        list = [await createProject('示例工程', await seedDoc())];
      }
      setProjects(list);
    })();
  }, []);

  if (!projects) return <Splash text={t('加载中…')} />;

  if (route.name === 'editor') {
    const meta = projects.find((p) => p.id === route.id);
    if (!meta) { go('#/'); return <Splash text={t('工程不存在，返回…')} />; }
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
      onDelete={async (id) => { await purgeProjectCascade(id); refresh(); }}  // Cascade: delete the project + clear its exclusive assets
      onExport={async (id, name) => {
        const r = await buildProjectExport(id, name);
        downloadBlob(r.blob, r.filename);
        return r.mediaMissing.length
          ? t('已导出「{name}」;{n} 个素材两端都取不到,未随包', { name, n: r.mediaMissing.length })
          : t('已导出「{name}」(含 {n} 个素材)', { name, n: r.mediaTotal });
      }}
      onImport={async (file) => {
        try {
          const r = await importProjectPackage(file);
          await refresh();
          return r.mediaMissing.length
            ? t('已导入「{name}」;缺 {n} 个素材({list})', { name: r.meta.name, n: r.mediaMissing.length, list: r.mediaMissing.map((s: string) => s.split('/').pop()).join('、') })
            : t('已导入「{name}」(素材 {a}/{b})', { name: r.meta.name, a: r.mediaRestored, b: r.mediaTotal });
        } catch (error) {
          return t('导入失败:{error}', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }}
    />
  );
}

// Blob download: Synchronous revoke will interrupt the Chrome download (plugin export is ignored), and DOM + delayed recycling must be installed.
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
