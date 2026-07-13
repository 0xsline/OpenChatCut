import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { timelineDuration } from '../editor/types';

// view_timeline_frames (source 护城河工具): render still frames of the CURRENT
// (draft!) timeline and hand them to the model as images — the agent SEES its
// own pending edits before the user even reviews the proposal. Server renders
// via /render-still (renderStill in headless Chrome, same bundle as export).

type Args = Record<string, unknown>;

export const FRAMES_TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'view_timeline_frames',
    description:
      'Render still frames of the timeline and SEE them as images (your pending edits included). Use after visual edits (adding MG/text, transitions, zoom, filters, aspect changes) to verify the result looks right before finishing. Provide exact frames OR seconds; with neither, 3 frames are sampled evenly. Max 8 per call.',
    input_schema: {
      type: 'object',
      properties: {
        frames: { type: 'array', items: { type: 'number' }, description: 'Exact frame numbers to render.' },
        seconds: { type: 'array', items: { type: 'number' }, description: 'Times in seconds to render (converted by fps).' },
        count: { type: 'number', description: 'No frames/seconds given: sample this many evenly across the timeline (default 3).' },
      },
    },
  },
];

export const FRAMES_TOOL_NAMES = new Set(FRAMES_TOOL_SCHEMAS.map((t) => t.name));

export async function execFramesTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'view_timeline_frames') return { error: `unknown tool ${name}` };
  const state = ctx.getState();
  const total = timelineDuration(state);
  let frames: number[];
  if (Array.isArray(args.frames) && args.frames.length) {
    frames = args.frames.map(Number);
  } else if (Array.isArray(args.seconds) && args.seconds.length) {
    frames = args.seconds.map((s) => Math.round(Number(s) * state.fps));
  } else {
    const n = Math.max(1, Math.min(8, Math.round(Number(args.count) || 3)));
    // sample midpoints of n even slices (avoids the black first/last frame)
    frames = Array.from({ length: n }, (_, i) => Math.round(((i + 0.5) / n) * total));
  }
  frames = [...new Set(frames.map((f) => Math.max(0, Math.min(total - 1, Math.round(f)))))].slice(0, 8);
  try {
    const res = await fetch('/render-still', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, frames }),
    });
    if (!res.ok) {
      const info = (await res.json().catch(() => null)) as { error?: string } | null;
      return { error: info?.error ?? `render-still failed (${res.status})` };
    }
    const data = (await res.json()) as { frames: { frame: number; base64: string }[] };
    return {
      __images: data.frames,
      note: `渲染了 ${data.frames.length} 帧（帧号 ${data.frames.map((f) => f.frame).join(', ')}，共 ${total} 帧 @${state.fps}fps）——以上即当前时间线（含你未提交的编辑）的实际画面。`,
    };
  } catch (e) {
    return { error: `render-still 请求失败: ${e instanceof Error ? e.message : String(e)}` };
  }
}
