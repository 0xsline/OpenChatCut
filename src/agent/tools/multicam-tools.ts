// multicam_sync provides audio-based multicam alignment in the
// editor (no backend path). Repositions follower angles so picture matches the
// reference angle's audio.
import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { canMulticamItem, runMulticamSync } from '../../multicam/sync';

export const MULTICAM_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'multicam_sync',
    description: [
      'Audio-based multicam alignment. Pass 2+ video/audio itemIds from the same take;',
      'optionally set referenceItemId (defaults to first video). Repositions each follower so its picture matches',
      'the reference audio. Runs in the editor only — no cloud job. After a cut in the reference, split cutaways',
      'first then sync each piece. Returns synced/skipped ids and lag diagnostics.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        itemIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Timeline item ids for all angles (reference + followers). At least 2.',
        },
        referenceItemId: {
          type: 'string',
          description: 'Optional reference angle id (must be in itemIds). Defaults to first video clip.',
        },
      },
      required: ['itemIds'],
    },
  },
];

export const MULTICAM_TOOL_NAMES = new Set(MULTICAM_TOOL_SCHEMAS.map((t) => t.name));

type Args = Record<string, unknown>;

export async function execMulticamTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'multicam_sync') return { error: `unknown tool ${name}` };
  const rawIds = Array.isArray(args.itemIds) ? args.itemIds.map(String) : [];
  if (rawIds.length < 2) return { error: 'itemIds needs at least 2 clips' };
  const ref = args.referenceItemId !== undefined ? String(args.referenceItemId) : undefined;
  if (ref && !rawIds.some((id) => id === ref || id.startsWith(ref) || ref.startsWith(id))) {
    return { error: 'referenceItemId must be included in itemIds' };
  }

  const state = ctx.getState();
  // Resolve short ids
  const resolved: string[] = [];
  for (const id of rawIds) {
    const hit = state.items.find((x) => x.id === id || x.id.startsWith(id));
    if (!hit) return { error: `item not found: ${id}` };
    if (!canMulticamItem(hit)) return { error: `item ${hit.id} is not video/audio with media` };
    if (state.tracks?.[hit.track]?.locked) return { error: `track ${hit.track} is locked` };
    resolved.push(hit.id);
  }

  const result = await runMulticamSync({
    state,
    itemIds: resolved,
    referenceItemId: ref,
  });

  if (result.changed && result.nextState) {
    ctx.commands.applyState(result.nextState);
  }

  return {
    ok: result.status === 'applied' || result.status === 'partial' || result.status === 'already_synced',
    status: result.status,
    changed: result.changed,
    referenceItemId: result.referenceItemId,
    syncedItemIds: result.syncedItemIds,
    skippedItemIds: result.skippedItemIds,
    offsets: result.offsets,
    message: result.message,
  };
}
