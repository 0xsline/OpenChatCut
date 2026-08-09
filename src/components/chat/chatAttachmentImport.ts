import type { AgentReference } from '../../agent/context';
import { refPromptToken } from '../../agent/selection-refs';
import type { MediaAsset } from '../../editor/types';
import { kindOf } from '../../media/upload';
import {
  attachChatAttachmentPlaceholder,
  beginChatAttachmentImport,
  failChatAttachmentImport,
  replaceChatAttachmentPromptToken,
  resolveChatAttachmentImport,
  type ChatAttachmentImportToken,
  type ChatAttachmentLifecycleState,
} from './chatAttachmentLifecycle';
import type { RefItem } from './ChatComposer';

type Translate = (key: string) => string;
type UpdateInput = (update: (value: string) => string) => void;

export type ChatMediaImporter = (
  file: File,
  onProgress?: (ratio: number) => void,
  lifecycle?: {
    onPlaceholder?: (asset: MediaAsset) => void;
    onAssetUpdated?: (asset: MediaAsset) => void;
    onFailure?: (asset: MediaAsset | null, error: unknown) => void;
  },
) => Promise<MediaAsset>;

interface AttachmentImportBinding {
  readonly t: Translate;
  readonly onImportMedia: ChatMediaImporter;
  readonly lifecycle: () => ChatAttachmentLifecycleState;
  readonly references: () => RefItem[];
  readonly commitLifecycle: (state: ChatAttachmentLifecycleState) => void;
  readonly commitReferences: (references: RefItem[]) => void;
  readonly updateInput: UpdateInput;
  readonly setError: (message: string | null) => void;
}

function assetReference(asset: MediaAsset): AgentReference {
  return { id: asset.id, name: asset.name, kind: asset.kind };
}

function acceptPlaceholder(binding: AttachmentImportBinding, token: ChatAttachmentImportToken, asset: MediaAsset): void {
  const reference = assetReference(asset);
  const transition = attachChatAttachmentPlaceholder(
    binding.lifecycle(), binding.references(), token, reference,
  );
  binding.commitLifecycle(transition.state);
  if (!transition.accepted) return;
  binding.commitReferences(transition.references);
  const promptToken = refPromptToken(reference);
  binding.updateInput((value) => value.includes(promptToken)
    ? value
    : `${value}${value && !value.endsWith(' ') ? ' ' : ''}${promptToken} `);
}

function acceptReady(binding: AttachmentImportBinding, token: ChatAttachmentImportToken, asset: MediaAsset): void {
  const reference = assetReference(asset);
  const transition = resolveChatAttachmentImport(
    binding.lifecycle(), binding.references(), token, reference,
  );
  binding.commitLifecycle(transition.state);
  if (!transition.accepted) return;
  binding.commitReferences(transition.references);
  const previous = transition.previousReference;
  if (previous) {
    binding.updateInput((value) => replaceChatAttachmentPromptToken(value, previous, reference));
  }
}

function acceptFailure(binding: AttachmentImportBinding, token: ChatAttachmentImportToken, reason: unknown): void {
  const transition = failChatAttachmentImport(binding.lifecycle(), binding.references(), token);
  binding.commitLifecycle(transition.state);
  if (!transition.accepted) return;
  binding.commitReferences(transition.references);
  if (transition.previousReference) {
    const escaped = refPromptToken(transition.previousReference)
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    binding.updateInput((value) => value.replace(new RegExp(`${escaped}\\s?`, 'g'), '').trimStart());
  }
  binding.setError(reason instanceof Error ? reason.message : binding.t('导入失败'));
}

async function importOne(binding: AttachmentImportBinding, file: File): Promise<void> {
  const started = beginChatAttachmentImport(binding.lifecycle());
  binding.commitLifecycle(started.state);
  try {
    const ready = await binding.onImportMedia(file, undefined, {
      onPlaceholder: (asset) => acceptPlaceholder(binding, started.token, asset),
      onAssetUpdated: (asset) => acceptReady(binding, started.token, asset),
      onFailure: (_asset, reason) => acceptFailure(binding, started.token, reason),
    });
    acceptReady(binding, started.token, ready);
  } catch (reason) {
    acceptFailure(binding, started.token, reason);
  }
}

/** Build the paste/drop importer while keeping lifecycle transitions outside ChatPanel. */
export function createChatAttachmentImporter(binding: AttachmentImportBinding): (files: File[]) => Promise<void> {
  return async (files) => {
    const supported = files.filter((file) => kindOf(file) !== null);
    binding.setError(supported.length < files.length
      ? binding.t('已忽略不支持的文件（仅支持 视频 / 图片 / 音频 / GIF / SVG）')
      : null);
    await Promise.all(supported.map((file) => importOne(binding, file)));
  };
}
