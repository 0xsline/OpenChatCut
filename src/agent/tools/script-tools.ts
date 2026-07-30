export { SCRIPT_TOOL_SCHEMAS, SCRIPT_TOOL_NAMES } from './schemas/script-tools';
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
// matching against stable [sN] segment ids preserves 词↔帧一致 (moat ③).

type Args = Record<string, unknown>;

function resolveRequestedTrack(args: Args, ctx: AgentContext): TrackId | undefined {
  if (args.track === undefined || args.track === null || String(args.track).trim() === '') return undefined;
  const ref = String(args.track).trim();
  const trackId = resolveTrackId(ctx.getState(), ref);
  if (!trackId) throw new Error(`轨道「${ref}」不存在`);
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
      if (!md.trim()) return { error: 'timelineMd is required（传回完整编辑后的 timeline.md）' };
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
