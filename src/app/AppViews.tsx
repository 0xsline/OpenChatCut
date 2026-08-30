import { lazy, Suspense, useEffect, useState } from 'react';
import { Dashboard } from '../components/Dashboard';
import type { ProjectDoc } from '../editor/types';
import { useT } from '../i18n/locale';
import { loadProjectForEditing, renameProject } from '../persist/projectStore';
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

type EditorLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; doc: ProjectDoc }
  | { kind: 'unreadable' };

function EditorLoader({ meta, onHome, onRename }: EditorLoaderProps) {
  const t = useT();
  const [load, setLoad] = useState<EditorLoadState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoad({ kind: 'loading' });
    void loadProjectForEditing(meta.id).then((result) => {
      if (!alive) return;
      // "missing" opens a legitimately empty project; "unreadable" must block
      // the editor — opening it empty would let autosave overwrite real data.
      if (result.status === 'ok') setLoad({ kind: 'ready', doc: result.doc });
      else if (result.status === 'missing') setLoad({ kind: 'ready', doc: emptyProjectDoc() });
      else setLoad({ kind: 'unreadable' });
    });
    return () => { alive = false; };
  }, [meta.id, attempt]);
  if (load.kind === 'loading') return <AppSplash text={t('加载工程…')} />;
  if (load.kind === 'unreadable') {
    return (
      <div style={{
        height: '100vh', display: 'grid', placeItems: 'center', background: theme.bg,
        fontFamily: 'Geist, system-ui, sans-serif',
      }}>
        <div style={{ display: 'grid', gap: 10, justifyItems: 'center', maxWidth: 420, textAlign: 'center' }}>
          <b style={{ color: theme.text, fontSize: 14 }}>{t('工程数据暂时无法读取')}</b>
          <span style={{ color: theme.textDim, fontSize: 12.5, lineHeight: 1.6 }}>
            {t('为避免覆盖已保存的内容，已停止打开该工程。数据仍保留在本机存储中，可稍后重试。')}
          </span>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => setAttempt((n) => n + 1)}
              style={{
                padding: '6px 14px', borderRadius: 6, border: `0.5px solid ${theme.border}`,
                background: theme.accent, color: theme.bg, fontSize: 12.5, cursor: 'pointer',
              }}
            >
              {t('重试')}
            </button>
            <button
              type="button"
              onClick={onHome}
              style={{
                padding: '6px 14px', borderRadius: 6, border: `0.5px solid ${theme.border}`,
                background: 'transparent', color: theme.text, fontSize: 12.5, cursor: 'pointer',
              }}
            >
              {t('返回工程列表')}
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <Suspense fallback={<AppSplash text={t('加载编辑器…')} />}>
      <Editor initial={load.doc} project={meta} onHome={onHome} onRename={onRename} />
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
