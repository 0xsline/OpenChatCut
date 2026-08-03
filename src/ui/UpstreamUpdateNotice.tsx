import { useEffect, useSyncExternalStore } from 'react';
import { useT } from '../i18n/locale';
import {
  dismissUpstreamUpdate,
  formatDisplayVersion,
  getUpstreamUpdateState,
  startAutomaticUpstreamUpdateCheck,
  subscribeUpstreamUpdate,
} from './upstreamUpdate';
import { UpstreamUpdateNoticeView } from './UpstreamUpdateNoticeView';

export function UpstreamUpdateNotice() {
  const t = useT();
  const update = useSyncExternalStore(
    subscribeUpstreamUpdate,
    getUpstreamUpdateState,
    getUpstreamUpdateState,
  );

  useEffect(() => { startAutomaticUpstreamUpdateCheck(); }, []);

  if (!update.visible) return null;

  let message: string;
  if (update.phase === 'available') {
    message = t('发现 OpenChatCut 新版本 {latest}，当前版本 {current}。请前往项目仓库查看更新。', {
      latest: formatDisplayVersion(update.latestVersion),
      current: formatDisplayVersion(update.currentVersion),
    });
  } else if (update.phase === 'current') {
    message = t('当前已是最新版本 {version}', {
      version: formatDisplayVersion(update.currentVersion),
    });
  } else {
    message = t('暂时无法检查更新，请稍后重试');
  }

  return (
    <UpstreamUpdateNoticeView
      message={message}
      closeLabel={t('关闭')}
      onDismiss={dismissUpstreamUpdate}
    />
  );
}
