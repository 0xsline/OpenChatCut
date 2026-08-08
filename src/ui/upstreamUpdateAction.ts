import { t } from '../i18n/locale';
import {
  openUpstreamReleasePage,
  formatDisplayVersion,
  requestUpstreamUpdateCheck,
  requestUpstreamUpdateDownload,
  requestUpstreamUpdateInstall,
  type UpstreamUpdateState,
} from './upstreamUpdate';

export type UpstreamUpdateCommand = 'check' | 'download' | 'install' | 'view-release' | 'none';

export interface UpstreamUpdateAction {
  readonly label: string;
  readonly disabled: boolean;
  readonly command: UpstreamUpdateCommand;
}

export function resolveUpstreamUpdateAction(
  state: UpstreamUpdateState,
  desktopUpdate: boolean,
): UpstreamUpdateAction {
  if (state.phase === 'checking') return { label: t('检查中…'), disabled: true, command: 'none' };
  if (state.phase === 'available') {
    return desktopUpdate
      ? { label: t('下载更新'), disabled: false, command: 'download' }
      : { label: t('查看发布页'), disabled: false, command: 'view-release' };
  }
  if (state.phase === 'downloading') {
    return {
      label: t('下载中 {percent}%', { percent: Math.round(state.percent) }),
      disabled: true,
      command: 'none',
    };
  }
  if (state.phase === 'downloaded') {
    return { label: t('重启并安装'), disabled: false, command: 'install' };
  }
  if (state.phase === 'installing') return { label: t('正在重启…'), disabled: true, command: 'none' };
  if (state.phase === 'error') {
    if (state.failedOperation === 'download') {
      return { label: t('重试下载'), disabled: false, command: 'download' };
    }
    if (state.failedOperation === 'install') {
      return { label: t('重试安装'), disabled: false, command: 'install' };
    }
    return { label: t('重新检查'), disabled: false, command: 'check' };
  }
  return { label: t('检查更新'), disabled: false, command: 'check' };
}

export function upstreamUpdateMessage(state: UpstreamUpdateState, desktopUpdate: boolean): string {
  if (state.phase === 'available') {
    const params = {
      latest: formatDisplayVersion(state.latestVersion),
      current: formatDisplayVersion(state.currentVersion),
    };
    return desktopUpdate
      ? t('发现 OpenChatCut 新版本 {latest}，当前版本 {current}。可以直接下载并安装。', params)
      : t('发现 OpenChatCut 新版本 {latest}，当前版本 {current}。请前往项目仓库查看更新。', params);
  }
  if (state.phase === 'current') {
    return t('当前已是最新版本 {version}', { version: formatDisplayVersion(state.currentVersion) });
  }
  if (state.phase === 'downloading') {
    return t('正在下载 OpenChatCut {latest}：{percent}%', {
      latest: formatDisplayVersion(state.latestVersion),
      percent: Math.round(state.percent),
    });
  }
  if (state.phase === 'downloaded') {
    return t('OpenChatCut {latest} 已下载，重启后完成安装。', {
      latest: formatDisplayVersion(state.latestVersion),
    });
  }
  if (state.phase === 'installing') return t('正在重启并安装 OpenChatCut…');
  if (state.phase === 'error' && state.failedOperation === 'download') return t('下载更新失败，请重试');
  if (state.phase === 'error' && state.failedOperation === 'install') return t('安装更新失败，请重试');
  return t('暂时无法检查更新，请稍后重试');
}

export function runUpstreamUpdateCommand(command: UpstreamUpdateCommand): void {
  if (command === 'check') void requestUpstreamUpdateCheck('manual');
  else if (command === 'download') void requestUpstreamUpdateDownload();
  else if (command === 'install') void requestUpstreamUpdateInstall();
  else if (command === 'view-release') openUpstreamReleasePage();
}
