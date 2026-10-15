// One file imported into the media pool: the placeholder shown while it
// uploads, the finished asset that replaces it, and cleanup when it fails.
// Its durations are counted at the rate the import started with, and every
// write says so: the project rate can change while a file still transcodes.
import { refreshVisualAnalysis } from '../agent/progress/visual-analysis-jobs';
import type { EditorCommands } from '../editor/store';
import { recountAssetDuration } from '../editor/timelineFrameRate';
import type { MediaAsset, TimelineState } from '../editor/types';
import type { t as translate } from '../i18n/locale';
import { shouldAutoTranscribeIngest } from '../transcript/provider';
import { createImportContentIdentityHooks } from './importContentIdentity';
import { mediaAssetRelinkPatch, uploadedMediaRelinkPatch } from './mediaAssetRelink';
import { findMediaNameConflict, MediaImportCancelledError } from './mediaImportConflict';
import { createImportTranscriptionGate, importMedia, type ImportMediaHooks, type ImportTranscriptionStart } from './upload';

export type StartAssetTranscription = (
  asset: ImportTranscriptionStart['asset'],
  asrPath?: string | null | Promise<string | null>,
  markRunning?: boolean,
  replaceExisting?: boolean,
) => void;
export type ImportLifecycle = {
  onPlaceholder?: (asset: MediaAsset) => void;
  onAssetUpdated?: (asset: MediaAsset) => void;
  onFailure?: (asset: MediaAsset | null, error: unknown) => void;
};

interface ImportTranscriptionGate {
  uploaded: (info: Parameters<NonNullable<ImportMediaHooks['onUploaded']>>[0]) => ImportTranscriptionStart | null;
  ready: (asset: MediaAsset) => ImportTranscriptionStart | null;
}
export interface PoolImportRun {
  commands: EditorCommands;
  stateRef: { current: TimelineState };
  startAssetTranscription: StartAssetTranscription;
  targetId?: string;
  placeholderId: string | null;
  placeholder: MediaAsset | null;
  canonicalizedAsset: MediaAsset | null;
  transcriptionGate: ImportTranscriptionGate;
  lifecycle?: ImportLifecycle;
}

export function poolImportHooks(run: PoolImportRun, onProgress?: (ratio: number) => void): ImportMediaHooks {
  return {
    onProgress,
    ...createImportContentIdentityHooks({
      getAssets: () => run.stateRef.current.assets ?? [],
      onCanonical: (canonical, duplicateId) => {
        run.canonicalizedAsset = canonical;
        run.commands.canonicalizeMediaAsset(run.targetId ?? duplicateId, canonical.id);
      },
    }),
    onPlaceholder: (asset, durationFps) => {
      if (run.targetId) return;
      run.placeholderId = asset.id;
      run.placeholder = asset;
      run.commands.addAsset(asset, durationFps);
      run.lifecycle?.onPlaceholder?.(asset);
    },
    onUploaded: (info) => {
      if (!run.targetId) run.commands.relinkMediaAsset(info.id, uploadedMediaRelinkPatch(info));
      const start = run.transcriptionGate.uploaded(info);
      if (start && shouldAutoTranscribeIngest()) run.startAssetTranscription(start.asset, start.asrPath);
    },
    onReady: (asset, durationFps) => {
      const ready = run.targetId ? { ...asset, id: run.targetId } : asset;
      run.commands.relinkMediaAsset(ready.id, mediaAssetRelinkPatch(ready, durationFps));
      const start = run.transcriptionGate.ready(ready);
      if (start && shouldAutoTranscribeIngest()) run.startAssetTranscription(start.asset, start.asrPath);
      if (ready.kind !== 'audio') refreshVisualAnalysis(ready);
    },
  };
}

export interface PoolImportContext {
  commands: EditorCommands;
  stateRef: { current: TimelineState };
  t: typeof translate;
}

export async function importAssetToPool(file: File, onProgress: ((ratio: number) => void) | undefined, lifecycle: ImportLifecycle | undefined, context: PoolImportContext, startAssetTranscription: StartAssetTranscription): Promise<MediaAsset> {
  const existing = findMediaNameConflict(context.stateRef.current.assets ?? [], file.name);
  if (existing && !window.confirm(context.t(
    '素材「{name}」已存在。覆盖会同步替换已在时间线中使用的该素材。',
    { name: existing.name },
  ))) throw new MediaImportCancelledError();
  const run: PoolImportRun = {
    commands: context.commands,
    stateRef: context.stateRef,
    startAssetTranscription,
    targetId: existing?.id,
    placeholderId: null,
    placeholder: null,
    canonicalizedAsset: null,
    transcriptionGate: createImportTranscriptionGate(existing?.id),
    lifecycle,
  };
  const fps = context.stateRef.current.fps;
  try {
    const imported = await importMedia(file, fps, poolImportHooks(run, onProgress));
    // Callers place what this returns, so it is counted at the rate the project has now.
    const ready = run.canonicalizedAsset ?? recountAssetDuration(
      run.targetId ? { ...imported, id: run.targetId } : imported, fps, context.stateRef.current.fps,
    );
    lifecycle?.onAssetUpdated?.(ready);
    return ready;
  } catch (error) {
    if (run.placeholderId) context.commands.removeMediaAsset(run.placeholderId);
    lifecycle?.onFailure?.(run.placeholder, error);
    throw error;
  }
}
