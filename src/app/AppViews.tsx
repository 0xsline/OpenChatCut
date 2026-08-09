import { lazy, Suspense, useEffect, useState } from 'react';
import { Dashboard } from '../components/Dashboard';
import type { ProjectDoc } from '../editor/types';
import { useT } from '../i18n/locale';
import { loadProject, renameProject } from '../persist/projectStore';
import type { ProjectMeta } from '../persist/projectStoreCoordinators';
import { theme } from '../theme';
import { emptyProjectDoc, navigateTo, type AppRoute } from './appShell';
import { useDashboardActions } from './useDashboardActions';

const Editor = lazy(() => import('../Editor'));

export function AppSplash({ text }: { text: string }) {
  return (
    <div style={{
      height: '100vh', display: 'grid', placeItems: 'center', background: theme.bg,
      color: theme.textDim, fontFamily: 'Geist, system-ui, sans-serif', fontSize: 13,
    }}>
      {text}
    </div>
  );
}

interface EditorLoaderProps {
  meta: ProjectMeta;
  onHome: () => void;
  onRename: (name: string) => void;
}

function EditorLoader({ meta, onHome, onRename }: EditorLoaderProps) {
  const t = useT();
  const [initial, setInitial] = useState<ProjectDoc | null>(null);
  useEffect(() => {
    let alive = true;
    loadProject(meta.id).then((document) => { if (alive) setInitial(document ?? emptyProjectDoc()); });
    return () => { alive = false; };
  }, [meta.id]);
  if (!initial) return <AppSplash text={t('加载工程…')} />;
  return (
    <Suspense fallback={<AppSplash text={t('加载编辑器…')} />}>
      <Editor initial={initial} project={meta} onHome={onHome} onRename={onRename} />
    </Suspense>
  );
}

interface EditorRouteProps {
  route: Extract<AppRoute, { name: 'editor' }>;
  projects: ProjectMeta[];
  refresh: () => Promise<void>;
}

export function EditorRoute({ route, projects, refresh }: EditorRouteProps) {
  const t = useT();
  const meta = projects.find((project) => project.id === route.id);
  if (!meta) {
    navigateTo('#/');
    return <AppSplash text={t('工程不存在，返回…')} />;
  }
  return (
    <EditorLoader
      key={meta.id}
      meta={meta}
      onHome={() => navigateTo('#/')}
      onRename={async (name) => { await renameProject(meta.id, name); refresh(); }}
    />
  );
}

export function DashboardRoute({
  projects,
  refresh,
}: {
  projects: ProjectMeta[];
  refresh: () => Promise<void>;
}) {
  const actions = useDashboardActions(refresh);
  return <Dashboard projects={projects} {...actions} />;
}
