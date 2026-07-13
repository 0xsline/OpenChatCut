import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context';
import { ASPECT_PRESETS, type AspectFit, type TrackId } from '../editor/types';
import type { Tpl } from '../types';
import { compileTemplate } from '../template-host';
import { anthropic, MODEL } from './client';
import { TRANSCRIPT_TOOL_SCHEMAS, TRANSCRIPT_TOOL_NAMES, execTranscriptTool } from './transcript-tools';
import { TIMELINE_TOOL_SCHEMAS, TIMELINE_TOOL_NAMES, execTimelineTool } from './timeline-tools';
import { SCRIPT_TOOL_SCHEMAS, SCRIPT_TOOL_NAMES, execScriptTool } from './script-tools';
import { GENERATE_TOOL_SCHEMAS, GENERATE_TOOL_NAMES, execGenerateTool } from './generate-tools';

// Anthropic native tool definitions (name / description / input_schema). Each
// one executes against the EditorCore command layer (tool == command). This is
// the source-faithful shape: Claude's Messages API tool-use, `strict`-exact.
export const TOOL_SCHEMAS: Anthropic.Tool[] = [
  {
    name: 'read_timeline',
    description: 'Read the current timeline: fps and every clip (id, track, name, startFrame, durationInFrames, props). Call this first to see current state before editing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_templates',
    description: 'Discover motion-graphic templates. With no args: returns the category list with counts. With a category: returns the template names in it. There are ~211 templates, so prefer a category or search_templates instead of listing everything.',
    input_schema: { type: 'object', properties: { category: { type: 'string', description: 'Optional category to list (e.g. "title-cards", "lower-thirds").' } } },
  },
  {
    name: 'search_templates',
    description: 'Fuzzy-search templates by name/category keyword. Use this to find a specific template among the ~211.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'add_motion_graphic',
    description: 'Add a motion-graphic template as a new clip. Placed at the end of the track unless startFrame is given.',
    input_schema: {
      type: 'object',
      properties: {
        templateName: { type: 'string', description: 'Template name (fuzzy match against list_templates).' },
        track: { type: 'string', enum: ['V1', 'V2'], description: 'Video track (default V1).' },
        startFrame: { type: 'number', description: 'Optional exact start frame; omit to append.' },
      },
      required: ['templateName'],
    },
  },
  {
    name: 'update_item_props',
    description: 'Change one or more editable props of a clip (e.g. text, colors). Only props from the template schema.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        props: { type: 'object', description: 'Map of propKey → new value.' },
      },
      required: ['itemId', 'props'],
    },
  },
  {
    name: 'move_item',
    description: 'Move a clip to a different track and/or start frame.',
    input_schema: {
      type: 'object',
      properties: {
        itemId: { type: 'string' },
        track: { type: 'string', enum: ['V1', 'V2', 'A1', 'A2'] },
        startFrame: { type: 'number' },
      },
      required: ['itemId'],
    },
  },
  {
    name: 'set_item_timing',
    description: 'Retime a clip: change its start frame and/or its duration (in frames). Use this to trim or lengthen a clip.',
    input_schema: {
      type: 'object',
      properties: { itemId: { type: 'string' }, startFrame: { type: 'number' }, durationInFrames: { type: 'number' } },
      required: ['itemId'],
    },
  },
  {
    name: 'duplicate_item',
    description: 'Duplicate a clip (the copy is appended to the end of its track).',
    input_schema: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
  },
  {
    name: 'remove_item',
    description: 'Delete a clip from the timeline.',
    input_schema: { type: 'object', properties: { itemId: { type: 'string' } }, required: ['itemId'] },
  },
  {
    name: 'split_item',
    description: 'Split a clip into two at the given absolute frame.',
    input_schema: { type: 'object', properties: { itemId: { type: 'string' }, atFrame: { type: 'number' } }, required: ['itemId', 'atFrame'] },
  },
  {
    name: 'list_audio',
    description: 'List available audio assets (music / SFX) that can be placed on audio tracks A1/A2.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'add_audio',
    description: 'Add an audio asset (music/SFX) as a clip on an audio track (A1/A2). Appended to the track end unless startFrame is given.',
    input_schema: {
      type: 'object',
      properties: {
        audioName: { type: 'string', description: 'Audio asset name (fuzzy match against list_audio).' },
        track: { type: 'string', enum: ['A1', 'A2'], description: 'Audio track (default A1).' },
        startFrame: { type: 'number', description: 'Optional exact start frame; omit to append.' },
      },
      required: ['audioName'],
    },
  },
  {
    name: 'create_motion_graphic',
    description: 'Generate a BRAND-NEW motion graphic from a description (writes fresh Remotion code, not from the library). Use only when no library template fits the user\'s intent.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the motion graphic should show/animate.' },
        name: { type: 'string', description: 'Short display name.' },
        durationSeconds: { type: 'number', description: 'Duration in seconds (default 3).' },
        track: { type: 'string', enum: ['V1', 'V2'] },
      },
      required: ['description', 'name'],
    },
  },
  {
    name: 'clear_timeline',
    description: 'Remove ALL clips from the timeline. Only when the user clearly asks to start over / clear everything.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_aspect_ratio',
    description: 'Retarget the canvas to a different aspect ratio for long-to-short (source manage_timelines ratio+fit). E.g. turn a 16:9 video vertical for Shorts/Reels. fit: contain (letterbox) keeps everything; cover (fill+crop) fills the frame and crops the sides.',
    input_schema: {
      type: 'object',
      properties: {
        ratio: { type: 'string', enum: ['16:9', '9:16', '1:1', '4:3', '3:4'] },
        fit: { type: 'string', enum: ['contain', 'cover'], description: 'How existing clips adapt to the new ratio.' },
      },
      required: ['ratio'],
    },
  },
  // transcript / captions / delete-text-=-delete-video (source: transcribe, find_transcript, clean_script, apply_script, edit_captions)
  ...TRANSCRIPT_TOOL_SCHEMAS,
  // multi-timeline management (source manage_timelines: list/create/duplicate/switch/update/delete)
  ...TIMELINE_TOOL_SCHEMAS,
  // Script system (source read_script/apply_script — timeline.md 往返, 护城河③)
  ...SCRIPT_TOOL_SCHEMAS,
  // AI 生成套件（GPT 主攻，定义在 generate-tools.ts：submit_image/video/voice/music/sound）
  ...GENERATE_TOOL_SCHEMAS,
];

let genCounter = 0;

// Ask the model to write a fresh Remotion MG component following the template
// contract. Uses the same native Anthropic client as the agent loop.
async function generateMgCode(description: string): Promise<string> {
  const sys = `You write ONE Remotion motion-graphic React component. Output ONLY the code — no markdown fences, no prose.
Contract (MUST follow exactly):
- Shape: const Name = ({item}) => { ...; return (<AbsoluteFill>...</AbsoluteFill>); };
- NO import / require / export. These globals are already injected: React, useCurrentFrame, useVideoConfig, interpolate, interpolateColors, spring, Easing, random, Img, Audio, Sequence, AbsoluteFill.
- Canvas is 1920x1080. Animate with useCurrentFrame()+interpolate()/spring({fps,frame,config}). Get { fps, durationInFrames } from useVideoConfig().
- Pure, synchronous rendering only. FORBIDDEN: fetch, XMLHttpRequest, WebSocket, document, window, globalThis, eval, new Function, .constructor, localStorage, setTimeout, setInterval, while(true), for(;;), debugger.
- Style inline. Make it clean and visually appealing (large readable text, tasteful colors, smooth fade/slide/scale animations).`;
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 64000, // don't truncate generated components
    system: sys,
    messages: [{ role: 'user', content: description }],
  });
  let code = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  code = code.replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim(); // strip fences
  return code;
}

type Args = Record<string, unknown>;

function findItem(ctx: AgentContext, itemId: unknown) {
  const id = String(itemId ?? '');
  const items = ctx.getState().items;
  return items.find((it) => it.id === id || it.id.startsWith(id)) ?? null;
}

// Execute a tool call against the live editor. Returns a JSON-serializable result.
export async function executeTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (TRANSCRIPT_TOOL_NAMES.has(name)) return execTranscriptTool(name, args, ctx);
  if (TIMELINE_TOOL_NAMES.has(name)) return execTimelineTool(name, args, ctx);
  if (SCRIPT_TOOL_NAMES.has(name)) return execScriptTool(name, args, ctx);
  if (GENERATE_TOOL_NAMES.has(name)) return execGenerateTool(name, args, ctx);
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
    case 'list_templates': {
      const cat = args.category ? String(args.category).toLowerCase() : null;
      if (!cat) {
        const counts: Record<string, number> = {};
        for (const t of ctx.templates) counts[t.category] = (counts[t.category] ?? 0) + 1;
        return { categories: counts, total: ctx.templates.length, hint: '传 category 或用 search_templates 精确找' };
      }
      return ctx.templates.filter((t) => t.category.toLowerCase() === cat).map((t) => t.name);
    }
    case 'search_templates': {
      const q = String(args.query ?? '').toLowerCase();
      return ctx.templates
        .filter((t) => t.name.toLowerCase().includes(q) || t.category.toLowerCase().includes(q))
        .slice(0, 15)
        .map((t) => ({ name: t.name, category: t.category }));
    }

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
    case 'set_item_timing': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      ctx.commands.setItemTiming(it.id, { startFrame: args.startFrame as number, durationInFrames: args.durationInFrames as number });
      return { ok: true, itemId: it.id };
    }
    case 'duplicate_item': {
      const it = findItem(ctx, args.itemId);
      if (!it) return { error: `no item ${args.itemId}` };
      ctx.commands.duplicateItem(it.id);
      return { ok: true, duplicated: it.name };
    }
    case 'list_audio':
      return ctx.audio.map((a) => ({ name: a.name, category: a.category, seconds: Math.round(a.durationInFrames / 30) }));
    case 'add_audio': {
      const q = String(args.audioName ?? '').toLowerCase();
      const asset = ctx.audio.find((a) => a.name.toLowerCase().includes(q));
      if (!asset) return { error: `no audio matching "${args.audioName}"`, available: ctx.audio.map((a) => a.name) };
      const track = (args.track as TrackId) ?? 'A1';
      const startFrame = typeof args.startFrame === 'number' ? args.startFrame : undefined;
      ctx.commands.addAudio(asset, { track, startFrame });
      return { ok: true, added: asset.name, track };
    }
    case 'create_motion_graphic': {
      const description = String(args.description ?? '').trim();
      if (!description) return { error: 'description is required' };
      const fps = ctx.getState().fps;
      const durationInFrames = Math.max(15, Math.round((Number(args.durationSeconds) || 3) * fps));
      let code: string;
      try {
        code = await generateMgCode(description);
      } catch (e) {
        return { error: `generation failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      if (!code) return { error: 'model returned empty code' };
      // Sandbox gate: compileTemplate runs the static blocklist (validateTemplate)
      // then compiles in the restricted scope — both must pass before we add it.
      try {
        compileTemplate(code);
      } catch (e) {
        return { error: `generated code rejected by sandbox: ${e instanceof Error ? e.message : String(e)}`, code };
      }
      const tpl: Tpl = {
        id: `gen_${++genCounter}`,
        name: String(args.name ?? 'Generated MG'),
        category: 'generated',
        width: 1920, height: 1080, fps,
        durationInFrames,
        props: {}, propSchema: [], thumb: null, code,
      };
      const track = (args.track as TrackId) ?? 'V1';
      ctx.commands.addMotionGraphic(tpl, { track });
      return { ok: true, generated: tpl.name, track, durationInFrames };
    }
    case 'clear_timeline':
      ctx.commands.clearTimeline();
      return { ok: true };
    case 'set_aspect_ratio': {
      const preset = ASPECT_PRESETS.find((p) => p.label === String(args.ratio));
      if (!preset) return { error: `unknown ratio ${args.ratio}` };
      const fit = (args.fit as AspectFit) ?? ctx.getState().fit ?? 'contain';
      ctx.commands.setAspect(preset.width, preset.height, fit);
      return { ok: true, ratio: preset.label, width: preset.width, height: preset.height, fit };
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
