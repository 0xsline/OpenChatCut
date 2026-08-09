import type { FormEvent, MouseEvent } from 'react';
import { useT } from '../i18n/locale';

export interface MediaPromptState {
  title: string;
  initialValue: string;
  rejectSlash?: boolean;
  onSubmit: (value: string) => void;
}

export interface MediaFolderDeleteState {
  id: string;
  name: string;
  parentId?: string;
}

export interface MediaAssetDeleteState {
  ids: string[];
  names: string[];
  usedCount: number;
}

interface MediaPoolDialogsProps {
  prompt: MediaPromptState | null;
  promptValue: string;
  folderDelete: MediaFolderDeleteState | null;
  assetDelete: MediaAssetDeleteState | null;
  assetDeleteTitle: string;
  onPromptValue: (value: string) => void;
  onSubmitPrompt: () => void;
  onClosePrompt: () => void;
  onDeleteFolder: (state: MediaFolderDeleteState) => void;
  onCloseFolderDelete: () => void;
  onDeleteAssets: (ids: string[]) => void;
  onCloseAssetDelete: () => void;
}

function PromptDialog(props: Pick<MediaPoolDialogsProps,
'prompt' | 'promptValue' | 'onPromptValue' | 'onSubmitPrompt' | 'onClosePrompt'>) {
  const t = useT();
  if (!props.prompt) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    props.onSubmitPrompt();
  };
  return <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t(props.prompt.title)}>
    <form className="cc-modal" onSubmit={submit}>
      <strong>{t(props.prompt.title)}</strong>
      <input autoFocus aria-label={t(props.prompt.title)} value={props.promptValue} onChange={(event) => props.onPromptValue(event.target.value)} />
      <div><button type="button" onClick={props.onClosePrompt}>{t('取消')}</button><button type="submit" className="primary">{t('确定')}</button></div>
    </form>
  </div>;
}

function FolderDeleteDialog(props: Pick<MediaPoolDialogsProps,
'folderDelete' | 'onDeleteFolder' | 'onCloseFolderDelete'>) {
  const t = useT();
  const state = props.folderDelete;
  if (!state) return null;
  return <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('删除空文件夹')}>
    <div className="cc-modal">
      <strong>{t('删除空文件夹「{name}」？', { name: state.name })}</strong>
      <div><button onClick={props.onCloseFolderDelete}>{t('取消')}</button><button className="danger" onClick={() => props.onDeleteFolder(state)}>{t('删除')}</button></div>
    </div>
  </div>;
}

function AssetDeleteDialog(props: Pick<MediaPoolDialogsProps,
'assetDelete' | 'assetDeleteTitle' | 'onDeleteAssets' | 'onCloseAssetDelete'>) {
  const t = useT();
  const state = props.assetDelete;
  if (!state) return null;
  const stop = (event: MouseEvent) => event.stopPropagation();
  const detail = state.usedCount > 0
    ? t('将删除 {count} 个素材，并从所有时间线移除其中 {used} 个素材对应的片段。', { count: state.ids.length, used: state.usedCount })
    : t('将从素材池删除 {count} 个素材。', { count: state.ids.length });
  return <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label={t('删除正在使用的素材')} onClick={props.onCloseAssetDelete}>
    <div className="cc-modal" onClick={stop}>
      <strong>{props.assetDeleteTitle}</strong>
      <p className="cc-asset-delete-detail">{detail}</p>
      <p className="cc-asset-delete-detail" title={state.names.join('\n')}>{state.names.join('、')}</p>
      <div><button type="button" onClick={props.onCloseAssetDelete}>{t('取消')}</button><button type="button" className="danger" onClick={() => props.onDeleteAssets(state.ids)}>{t('确认删除')}</button></div>
    </div>
  </div>;
}

export function MediaPoolDialogs(props: MediaPoolDialogsProps) {
  return <>
    <PromptDialog {...props} />
    <FolderDeleteDialog {...props} />
    <AssetDeleteDialog {...props} />
  </>;
}
