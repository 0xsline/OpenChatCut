import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { serializeTimeline } from '../../script/serialize';
import { applyScript } from '../../script/apply';
import { makeDraft } from '../../editor/store';
import { resolveTrackId, type TrackId } from '../../editor/types';

// read_script / apply_script serialize the timeline to segment-id-coded Markdown;
// the agent edits the TEXT, apply diffs it back to deterministic operations.
// We implement the "no-workspace" host mode:
// read_script returns timeline.md inline; apply_script takes the edited string
// back via `timelineMd`. Word timestamps never appear in the file — content
// matching against stable [sN] segment ids preserves word↔frame consistency (moat ③).

type Args = Record<string, unknown>;

export const SCRIPT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'read_script',
    description:
      'Materialize the current timeline as timeline.md (segment-id-coded Markdown). Track sections (## V1/A1…), source regions (### file), rows: [sN] transcript sentence / [cN] Nf clip / [gap Nf]. Body order = playback order. Read this before apply_script; edit the TEXT then pass it back. Keep the <!-- script-stamp --> comment intact.',
    input_schema: {
      type: 'object',
      properties: {
        track: { type: 'string', description: 'Optional timeline track alias/id. Omit to keep the existing full-timeline behavior.' },
        showSilence: { type: 'boolean', description: 'Include editable [silence=Ns] markers. Default false.' },
      },
    },
  },
  {
    name: 'apply_script',
    description:
      'Commit an edited timeline.md back to the timeline (atomic; any invalid row rejects the whole script). Edit grammar: strike words inside a [sN] row with ~~word~~ (delete text = delete video); strike or delete a whole row to remove it; reorder rows to reorder clips (frames are re-derived from body order — never write frame numbers); deleting a [gap Nf] row closes the gap. Re-adding previously deleted words restores them. Do NOT change spoken words. preview=true validates and reports without changing anything.',
    input_schema: {
      type: 'object',
      properties: {
        timelineMd: { type: 'string', description: 'The FULL edited timeline.md content (from read_script, with your edits).' },
        preview: { type: 'boolean', description: 'true = validate + report the diff without applying.' },
        track: { type: 'string', description: 'Optional timeline track alias/id. Use the same scope as read_script.' },
      },
      required: ['timelineMd'],
    },
  },
];

export const SCRIPT_TOOL_NAMES = new Set(SCRIPT_TOOL_SCHEMAS.map((t) => t.name));

function resolveRequestedTrack(args: Args, ctx: AgentContext): TrackId | undefined {
  if (args.track === undefined || args.track === null || String(args.track).trim() === '') return undefined;
  const ref = String(args.track).trim();
  const trackId = resolveTrackId(ctx.getState(), ref);
  if (!trackId) throw new Error(`Orbit "${ref}” does not exist`);
  return trackId;
}

export async function execScriptTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  switch (name) {
    case 'read_script': {
      try {
        const trackId = resolveRequestedTrack(args, ctx);
        const { md } = serializeTimeline(ctx.getState(), { trackId, showSilence: args.showSilence === true });
        return { file: 'timeline.md', content: md, ...(trackId ? { trackId } : {}) };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }
    case 'apply_script': {
      const md = String(args.timelineMd ?? '');
      if (!md.trim()) return { error: 'timelineMd is required(Returns fully edited timeline.md）' };
      try {
        const trackId = resolveRequestedTrack(args, ctx);
        if (args.preview === true) {
          // dry-run against an inner scratch draft — nothing escapes it
          const scratch = makeDraft(ctx.getDoc());
          const r = applyScript(scratch.getState, scratch.commands, md, { trackId });
          return { ok: true, preview: true, wouldRemove: r.removed, wouldChange: r.changes };
        }
        const r = applyScript(ctx.getState, ctx.commands, md, { trackId });
        return { ok: true, removed: r.removed, changes: r.changes };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
