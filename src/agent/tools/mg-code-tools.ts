export { MG_CODE_TOOL_SCHEMAS, MG_CODE_TOOL_NAMES } from './schemas/mg-code-tools';
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';
import { prepareTemplate } from '../../template-host';

// create_motion_graphic_from_code registers inline MG JSX as a pool asset.

type Args = Record<string, unknown>;

const newId = (): string =>
  (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `mg_${Date.now().toString(36)}`;

export async function execMgCodeTool(
  name: string,
  args: Args,
  ctx: AgentContext,
): Promise<unknown> {
  if (name !== 'create_motion_graphic_from_code') return { error: `unknown tool ${name}` };

  const code = String(args.code ?? '').trim();
  const nameStr = String(args.name ?? '').trim();
  const width = Number(args.width);
  const height = Number(args.height);
  if (!code) return { error: 'code is required' };
  if (!nameStr) return { error: 'name is required' };
  if (!(width > 0) || !(height > 0)) return { error: 'width and height must be positive numbers' };

  try {
    await prepareTemplate(code);
  } catch (e) {
    return {
      error: `code rejected by sandbox: ${e instanceof Error ? e.message : String(e)}`,
      code,
    };
  }

  const fps = ctx.getState().fps || 30;
  let durationInFrames: number;
  if (typeof args.durationInFrames === 'number' && args.durationInFrames > 0) {
    durationInFrames = Math.round(args.durationInFrames);
  } else if (typeof args.durationInSeconds === 'number' && args.durationInSeconds > 0) {
    durationInFrames = Math.max(1, Math.round(args.durationInSeconds * fps));
  } else {
    durationInFrames = Math.round(3 * fps);
  }

  const props: Record<string, unknown> = {};
  if (typeof args.description === 'string' && args.description.trim()) {
    props.__description = args.description.trim();
  }
  if (Array.isArray(args.properties)) {
    for (const p of args.properties) {
      if (p && typeof p === 'object' && 'key' in p) {
        const row = p as { key: string; defaultValue?: unknown };
        if (typeof row.key === 'string' && row.key) props[row.key] = row.defaultValue;
      }
    }
  }

  const asset: MediaAsset = {
    id: newId(),
    name: nameStr,
    kind: 'motion-graphic',
    src: '', // code-backed; no media file
    code,
    durationInFrames,
    width: Math.round(width),
    height: Math.round(height),
    props,
  };
  ctx.commands.addAsset(asset);

  return {
    ok: true,
    assetId: asset.id,
    name: asset.name,
    kind: 'motion-graphic',
    width: asset.width,
    height: asset.height,
    durationInFrames: asset.durationInFrames,
    note: 'MG asset registered in media pool. Place with edit_item adds or UI.',
  };
}
