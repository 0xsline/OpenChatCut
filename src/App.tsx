
import { useT } from './i18n/locale';
import {
  useAgentBackendSync,
  useAppRoute,
  useLocalAsrWarmup,
  useProjects,
} from './app/appShell';
import { AppSplash, DashboardRoute, EditorRoute } from './app/AppViews';

export default function App() {
  const t = useT();
  const route = useAppRoute();
  useAgentBackendSync();
  useLocalAsrWarmup(route.name);
  const { projects, refresh } = useProjects();

  if (!projects) return <AppSplash text={t('加载中…')} />;
  if (route.name === 'editor') {
    return <EditorRoute route={route} projects={projects} refresh={refresh} />;
  }
  return <DashboardRoute projects={projects} refresh={refresh} />;
}
