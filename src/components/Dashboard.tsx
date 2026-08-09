import { theme } from '../theme';
import { UpstreamUpdateNotice } from '../ui/UpstreamUpdateNotice';
import { DesktopWindowControls } from './DesktopWindowControls';
import {
  DashboardContent,
  DashboardDialogs,
  DashboardTitlebarContent,
} from './dashboard/DashboardViews';
import { useDashboardModel, type DashboardProps } from './dashboard/useDashboardModel';

export function Dashboard(props: DashboardProps) {
  const model = useDashboardModel(props);
  const isMacDesktop = window.openChatCutDesktop?.platform === 'darwin';
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: theme.bg, color: theme.text, fontFamily: 'Geist, system-ui, -apple-system, sans-serif' }}>
      <UpstreamUpdateNotice />
      <header className={`cc-window-titlebar${isMacDesktop ? ' cc-window-titlebar--mac' : ''}`} style={{ position: 'relative', height: 48, flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 10, padding: '0 24px', borderBottom: `0.5px solid ${theme.border}`, background: theme.panel }}>
        <DesktopWindowControls />
        <DashboardTitlebarContent model={model} />
      </header>
      <DashboardContent props={props} model={model} />
      <DashboardDialogs model={model} />
    </div>
  );
}
