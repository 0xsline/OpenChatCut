import { useCallback, useRef, useState, type RefObject } from 'react';
import type { MediaAsset } from '../editor/types';
import type { t as translate } from '../i18n/locale';
import {
  canPickMediaFolder,
  collectDroppedFiles,
  DIRECTORY_SCAN_MAX_DEPTH,
  DIRECTORY_SCAN_MAX_FILES,
  hasDirectoryEntries,
  pickMediaFolder,
  type DirectoryScanResult,
} from './directoryDrop';
import { mediaImportErrorMessage } from './mediaImportConflict';
import { importMediaBatch } from './mediaPoolImport';

interface ImportLifecycle {
  onPlaceholder?: (asset: MediaAsset) => void;
  onAssetUpdated?: (asset: MediaAsset) => void;
  onFailure?: (asset: MediaAsset | null, error: unknown) => void;
}

type ImportMedia = (
  file: File,
  onProgress?: (ratio: number) => void,
  lifecycle?: ImportLifecycle,
) => Promise<MediaAsset>;

interface UseMediaPoolFileImportOptions {
  onImport: ImportMedia;
  onMoveAssets: (ids: string[], folderId?: string) => void;
  onCreateFolder: (name: string, parentId?: string) => string;
  setError: (error: string | null) => void;
  t: typeof translate;
}

interface MediaPoolFileImportState {
  inputRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  uploadRatio: number | null;
  setBusy: (busy: boolean) => void;
  canPickDirectory: boolean;
  pickFiles: (files: FileList | readonly File[] | null, folderId?: string) => Promise<boolean>;
  pickDirectory: (folderId?: string) => Promise<void>;
  handleDrop: (transfer: DataTransfer, folderId?: string) => Promise<void>;
}

function directoryNotice(result: DirectoryScanResult, t: typeof translate): string | null {
  const notices: string[] = [];
  if (result.limitReached) {
    notices.push(t('文件夹导入不完整：仅检查前 {n} 个文件。', { n: DIRECTORY_SCAN_MAX_FILES }));
  }
  if (result.depthReached) {
    notices.push(t('文件夹导入不完整：已跳过超出 {n} 层的内容。', { n: DIRECTORY_SCAN_MAX_DEPTH }));
  }
  if (result.unsupportedFiles > 0) {
    notices.push(t('已跳过 {n} 个不支持的文件。', { n: result.unsupportedFiles }));
  }
  return notices.length ? notices.join(' ') : null;
}

function isPickerCancellation(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError';
}

type PickFiles = MediaPoolFileImportState['pickFiles'];
type ImportFiles = (
  files: FileList | readonly File[] | null,
  folderId?: string,
  targetFolderIds?: readonly (string | undefined)[],
) => Promise<boolean>;

export function materializeDirectoryFolders(
  result: DirectoryScanResult,
  parentFolderId: string | undefined,
  createFolder: (name: string, parentId?: string) => string,
): readonly (string | undefined)[] {
  const idsByPath = new Map<string, string>();
  const paths = [...result.directories, ...result.folderPaths];
  const folderIds = paths.map((path) => {
    let parentId = parentFolderId;
    for (const name of path) {
      const key = JSON.stringify([parentId ?? null, name]);
      const id = idsByPath.get(key) ?? createFolder(name, parentId);
      idsByPath.set(key, id);
      parentId = id;
    }
    return parentId;
  });
  return folderIds.slice(result.directories.length);
}

function useDirectoryFileActions(
  importFiles: ImportFiles,
  onCreateFolder: UseMediaPoolFileImportOptions['onCreateFolder'],
  setError: (error: string | null) => void,
  t: typeof translate,
): Pick<MediaPoolFileImportState, 'pickDirectory' | 'handleDrop'> {
  const importResult = useCallback(async (result: DirectoryScanResult, folderId?: string) => {
    const notice = directoryNotice(result, t);
    if (!result.files.length) {
      setError(notice ?? t('文件夹中没有文件。'));
      return;
    }
    const targetFolderIds = materializeDirectoryFolders(result, folderId, onCreateFolder);
    if (await importFiles(result.files, folderId, targetFolderIds) && notice) setError(notice);
  }, [importFiles, onCreateFolder, setError, t]);
  const pickDirectory = useCallback(async (folderId?: string) => {
    try {
      const result = await pickMediaFolder();
      if (result.scanned) await importResult(result, folderId);
    } catch (reason) {
      if (!isPickerCancellation(reason)) setError(mediaImportErrorMessage(reason));
    }
  }, [importResult, setError]);
  const handleDrop = useCallback(async (transfer: DataTransfer, folderId?: string) => {
    if (!hasDirectoryEntries(transfer)) {
      await importFiles(transfer.files, folderId);
      return;
    }
    try {
      await importResult(await collectDroppedFiles(transfer), folderId);
    } catch (reason) {
      setError(mediaImportErrorMessage(reason));
    }
  }, [importFiles, importResult, setError]);
  return { pickDirectory, handleDrop };
}

export function useMediaPoolFileImport(options: UseMediaPoolFileImportOptions): MediaPoolFileImportState {
  const { onImport, onMoveAssets, onCreateFolder, setError, t } = options;
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadRatio, setUploadRatio] = useState<number | null>(null);
  const importFiles = useCallback<ImportFiles>(async (files, folderId, targetFolderIds) => {
    if (!files?.length) return true;
    setBusy(true);
    setError(null);
    setUploadRatio(0);
    try {
      const completionErrors = await importMediaBatch({
        files: Array.from(files), targetFolderId: folderId, targetFolderIds, onImport, onMoveAssets,
        onProgress: (ratio) => setUploadRatio((current) => Math.max(current ?? 0, ratio)),
      });
      if (completionErrors.length) throw completionErrors[0];
      setUploadRatio(1);
      return true;
    } catch (reason) {
      setError(mediaImportErrorMessage(reason));
      return false;
    } finally {
      setBusy(false);
      setUploadRatio(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }, [onImport, onMoveAssets, setError]);
  const pickFiles = useCallback<PickFiles>((files, folderId) => (
    importFiles(files, folderId)
  ), [importFiles]);
  const directory = useDirectoryFileActions(importFiles, onCreateFolder, setError, t);
  return {
    inputRef, busy, setBusy, uploadRatio, canPickDirectory: canPickMediaFolder(),
    pickFiles, ...directory,
  };
}
