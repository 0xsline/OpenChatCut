export { UPLOAD_TOOL_SCHEMAS, UPLOAD_TOOL_NAMES } from './schemas/upload-tools';
import type { AgentContext } from '../context';
import { execFinalizeUpload } from './upload-finalize';
import {
  execImportMediaHandoff,
  findUploadAsset as findAsset,
} from './upload-handoff-tools';

// External import flow:
//   import_media(create_session) → one-shot slot upload → finalize_uploaded_asset.
// The asset identity is issued from the verified upload receipt, never from client paths.

type Args = Record<string, unknown>;


export async function execUploadTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name === 'import_media') return execImportMediaHandoff(args, ctx);
  if (name === 'finalize_uploaded_asset') return execFinalizeUpload(args, ctx);
  if (name === 'request_asset_download') return execRequestDownload(args, ctx);
  return { error: `unknown tool ${name}` };
}




function execRequestDownload(args: Args, ctx: AgentContext): unknown {
  const q = String(args.assetId ?? '').trim();
  if (!q) return { error: 'assetId is required' };
  if (args.variant != null && args.variant !== 'source') {
    return { error: 'only variant "source" is supported' };
  }
  const asset = findAsset(ctx, q);
  if (!asset) return { error: `asset not found: ${q}` };
  if (!asset.src) {
    return {
      error: 'asset has no source media file (e.g. motion-graphic without baked video)',
      hint: 'Export MG via export_motion_graphic_prores or convert_motion_graphic_to_video first.',
    };
  }

  const origin = typeof location !== 'undefined' && location.origin ? location.origin : '';
  const downloadUrl = asset.src.startsWith('http')
    ? asset.src
    : origin
      ? `${origin}${asset.src.startsWith('/') ? '' : '/'}${asset.src}`
      : asset.src;

  return {
    ok: true,
    localDev: true,
    assetId: asset.id,
    name: asset.name,
    type: asset.kind,
    variant: 'source',
    path: asset.src,
    downloadUrl,
    note: 'Open downloadUrl in the browser or use as <a download>. Local-dev has no signed expiry.',
  };
}
