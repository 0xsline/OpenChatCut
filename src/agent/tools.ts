import type { AgentContext } from './context';
import type { TrackId } from '../editor/types';

// OpenAI-style tool schemas. These mirror ChatCut's domain tools; each one
// executes against the EditorCore command layer (tool == command).
export const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'read_timeline',
      description: 'Read the current timeline: fps and every clip (id, track, name, startFrame, durationInFrames, props). Call this first to see current state before editing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_templates',
      description: 'List the available motion-graphic templates (name + category) that can be added to the timeline.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_motion_graphic',
      description: 'Add a motion-graphic template as a new clip. Placed at the end of the track unless startFrame is given.',
      parameters: {
        type: 'object',
        properties: {
          templateName: { type: 'string', description: 'Template name (fuzzy match against list_templates).' },
          track: { type: 'string', enum: ['V1', 'V2'], description: 'Video track (default V1).' },
          startFrame: { type: 'number', description: 'Optional exact start frame; omit to append.' },
        },
        required: ['templateName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_item_props',
      description: 'Change one or more editable props of a clip (e.g. text, colors). Only props from the template schema.',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          props: { type: 'object', description: 'Map of propKey → new value.' },
        },
        required: ['itemId', 'props'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_item',
      description: 'Move a clip to a different track and/or start frame.',
      parameters: {
        type: 'object',
        properties: {
          itemId: { type: 'string' },
          track: { type: 'string', enum: ['V1', 'V2', 'A1', 'A2'] },
          startFrame: { type: 'number' },
        },
        required: ['itemId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_item',
      description: 'Delete a clip from the timeline.',
      parameters: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'split_item',
      description: 'Split a clip into two at the given absolute frame.',
      parameters: { type: 'object', properties: { itemId: { type: 'string' }, atFrame: { type: 'number' } }, required: ['itemId', 'atFrame'] },
    },
  },
] as const;

type Args = Record<string, unknown>;

function findItem(ctx: AgentContext, itemId: unknown) {
  const id = String(itemId ?? '');
  const items = ctx.getState().items;
  return items.find((it) => it.id === id || it.id.startsWith(id)) ?? null;
}

// Execute a tool call against the live editor. Returns a JSON-serializable result.
export function executeTool(name: string, args: Args, ctx: AgentContext): unknown {
  switch (name) {
    case 'read_timeline': {
      const s = ctx.getState();
      return {
        fps: s.fps,
        items: s.items.map((it) => ({
          id: it.id, track: it.track, name: it.name,
          startFrame: it.startFrame, durationInFrames: it.durationInFrames, props: it.props,
        })),
      };
    }
    case 'list_templates':
      return ctx.templates.map((t) => ({ name: t.name, category: t.category }));

    case 'add_motion_graphic': {
      const q = String(args.templateName ?? '').toLowerCase();
      const matches = ctx.templates.filter((t) => t.name.toLowerCase().includes(q));
      if (matches.length === 0) return { error: `no template matching "${args.templateName}"`, available: ctx.templates.map((t) => t.name) };
      const tpl = matches[0];
      const track = (args.track as TrackId) ?? 'V1';
      const startFrame = typeof args.startFrame === 'number' ? args.startFrame : undefined;
      ctx.commands.addMotionGraphic(tpl, { track, startFrame });
      return { ok: true, added: tpl.name, track };
    }
    case 'update_item_props': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      ctx.commands.updateItemProps(it.id, (args.props ?? {}) as Args);
      return { ok: true, itemId: it.id, updated: Object.keys((args.props ?? {}) as Args) };
    }
    case 'move_item': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      ctx.commands.moveItem(it.id, { track: args.track as TrackId, startFrame: args.startFrame as number });
      return { ok: true, itemId: it.id };
    }
    case 'remove_item': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      ctx.commands.removeItem(it.id);
      return { ok: true, removed: it.name };
    }
    case 'split_item': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      ctx.commands.splitItem(it.id, Number(args.atFrame));
      return { ok: true, itemId: it.id };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
