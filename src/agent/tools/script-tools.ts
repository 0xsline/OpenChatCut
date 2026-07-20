import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import { serializeTimeline } from '../../script/serialize';
import { applyScript } from '../../script/apply';
import { makeDraft } from '../../editor/store';

// read_script / apply_script serialize the timeline to segment-id-coded Markdown;
// the agent edits the TEXT, apply diffs it back to deterministic operations.
// We implement the "no-workspace" host mode:
// read_script returns timeline.md inline; apply_script takes the edited string
// back via `timelineMd`. Word timestamps never appear in the file — content
// matching against stable [sN] segment ids preserves 词↔帧一致 (moat ③).

type Args = Record<string, unknown>;

export const SCRIPT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'read_script',
    description:
      'Materialize the current timeline as timeline.md (segment-id-coded Markdown). Track sections (## V1/A1…), source regions (### file), rows: [sN] transcript sentence / [cN] Nf clip / [gap Nf]. Body order = playback order. Read this before apply_script; edit the TEXT then pass it back. Keep the <!-- script-stamp --> comment intact.',
    input_schema: { type: 'object', properties: {} },
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
      },
      required: ['timelineMd'],
    },
  },
];

export const SCRIPT_TOOL_NAMES = new Set(SCRIPT_TOOL_SCHEMAS.map((t) => t.name));

export async function execScriptTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  switch (name) {
    case 'read_script': {
      const { md } = serializeTimeline(ctx.getState());
      return { file: 'timeline.md', content: md };
    }
    case 'apply_script': {
      const md = String(args.timelineMd ?? '');
      if (!md.trim()) return { error: 'timelineMd is required（传回完整编辑后的 timeline.md）' };
      try {
        if (args.preview === true) {
          // dry-run against an inner scratch draft — nothing escapes it
          const scratch = makeDraft(ctx.getDoc());
          const r = applyScript(scratch.getState, scratch.commands, md);
          return { ok: true, preview: true, wouldRemove: r.removed, wouldChange: r.changes };
        }
        const r = applyScript(ctx.getState, ctx.commands, md);
        return { ok: true, removed: r.removed, changes: r.changes };
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
      }
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}
