import { Icon } from '../components/icons';
import { useT } from '../i18n/locale';

interface DirectoryImportActionsProps {
  onPickFolder?: () => void;
  onWatchFolder?: () => void;
  onStopWatch: () => void;
  watchingFolder: string | null;
  watchBusy: boolean;
  run: (action: () => void) => void;
}

export function DirectoryImportActions(props: DirectoryImportActionsProps) {
  const t = useT();
  const pickFolder = props.onPickFolder;
  const watchFolder = props.onWatchFolder;
  return <>
    {pickFolder && <button onClick={() => props.run(pickFolder)}>
      <Icon name="folderPlus" size={16} />{t('导入文件夹…')}
    </button>}
    {watchFolder && (props.watchingFolder
      ? <button onClick={() => props.run(props.onStopWatch)}>
        <Icon name="x" size={15} />{props.watchBusy
          ? t('停止正在准备的监听文件夹「{dir}」', { dir: props.watchingFolder })
          : t('停止监听文件夹「{dir}」', { dir: props.watchingFolder })}
      </button>
      : <button disabled={props.watchBusy} onClick={() => props.run(watchFolder)}>
        <Icon name="folder" size={15} />{props.watchBusy
          ? t('正在选择监听文件夹…')
          : t('监听文件夹（自动导入新素材）…')}
      </button>)}
  </>;
}
