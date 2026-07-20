import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../context';
import type { MediaAsset } from '../../editor/types';
import { compileTemplate } from '../../template-host';

// create_motion_graphic_from_code registers inline MG JSX as a pool asset.

type Args = Record<string, unknown>;

export const MG_CODE_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'create_motion_graphic_from_code',
    description: [
      'Create a new Motion Graphic asset from inline React/JSX code.',
      'Required: code, name, width, height. Duration via durationInFrames or durationInSeconds.',
      'The COMPLETE JSX must be in this single call — no declare-first-fill-later; a call without code is rejected.',
      'Code must pass the local MG sandbox (same as edit_asset). Does not auto-place on the timeline —',
      'use edit_item / add_motion_graphic / manage_media_pool to place after.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Inline Motion Graphic React/JSX. Not a file path.' },
        name: { type: 'string', description: 'Asset display name.' },
        width: { type: 'number', description: 'Natural box width in pixels.' },
        height: { type: 'number', description: 'Natural box height in pixels.' },
        durationInFrames: {
          type: 'number',
          description: 'Duration in timeline frames (mutually exclusive with durationInSeconds).',
        },
        durationInSeconds: {
          type: 'number',
          description: 'Duration in seconds (mutually exclusive with durationInFrames).',
        },
        description: { type: 'string', description: 'Optional human description (stored in props).' },
        properties: {
          type: 'array',
          description: 'Editable props: { key, label?, type?, defaultValue }[].',
          items: {},
        },
        projectId: { type: 'string', description: 'Ignored; the active project is used.' },
      },
      required: ['code', 'name', 'width', 'height'],
    },
  },
];

export const MG_CODE_TOOL_NAMES = new Set(MG_CODE_TOOL_SCHEMAS.map((t) => t.name));

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
    compileTemplate(code);
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
