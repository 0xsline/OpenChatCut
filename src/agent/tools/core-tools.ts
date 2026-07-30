import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import { ASPECT_PRESETS, defaultTrackId, resolveTrackId, timelineTrackIds, trackAlias, trackKind } from '../../editor/types';
import type { AspectFit, MediaAsset } from '../../editor/types';
import { prepareTemplate } from '../../template-host';
import { generateAgentText } from '../client';
import { designStyleHint } from '../systemPrompt';

type Args = Record<string, unknown>;

function findItem(ctx: AgentContext, itemId: unknown) {
  const id = String(itemId ?? '');
  return ctx.getState().items.find((item) => item.id === id || item.id.startsWith(id)) ?? null;
}

function searchTools(args: Args, schemas: readonly AgentToolSchema[]): unknown {
  const query = String(args.query ?? '').trim().toLowerCase();
  if (!query) return { error: 'query is required', results: [] };
  const limit = Math.min(30, Math.max(1, Math.round(Number(args.limit) || 12)));
  const tokens = query.split(/\s+/).filter(Boolean);
  const scored = schemas
    .filter((tool) => tool.name !== 'ToolSearch')
    .map((tool) => {
      const haystack = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (tool.name.toLowerCase() === token) score += 10;
        else if (tool.name.toLowerCase().includes(token)) score += 5;
        else if (haystack.includes(token)) score += 2;
      }
      return { tool, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .slice(0, limit);
  return {
    query,
    count: scored.length,
    results: scored.map(({ tool }) => ({ name: tool.name, description: (tool.description ?? '').slice(0, 280) })),
    note: scored.length
      ? 'Call matching tools by exact name; schemas are already in this session.'
      : 'No tools matched; try export / caption / stock / video / voice.',
  };
}

function readTimeline(ctx: AgentContext): unknown {
  const state = ctx.getState();
  return {
    fps: state.fps,
    tracks: timelineTrackIds(state).map((id) => ({ id, alias: trackAlias(state, id), trackType: trackKind(state, id) })),
    items: state.items.map((item) => ({
      id: item.id, trackId: item.track, track: trackAlias(state, item.track), name: item.name,
      startFrame: item.startFrame, durationInFrames: item.durationInFrames, props: item.props,
      zoom: item.zoom ?? null,
      effects: (item.effects ?? []).map((effect) => ({ effectId: effect.id, assetId: effect.assetId, overrides: effect.overrides ?? {} })),
    })),
    transitions: (state.transitions ?? []).map((transition) => ({
      id: transition.id, type: transition.type, assetId: `builtin:tr-${transition.type}`,
      durationInFrames: transition.durationInFrames,
      outgoingItemId: transition.outgoingItemId, incomingItemId: transition.incomingItemId,
      trackId: transition.trackId,
    })),
  };
}

function execTemplateCatalog(name: string, args: Args, ctx: AgentContext): unknown {
  if (name === 'list_templates') {
    const category = args.category ? String(args.category).toLowerCase() : null;
    if (category) return ctx.templates.filter((template) => template.category.toLowerCase() === category).map((template) => template.name);
    const categories: Record<string, number> = {};
    for (const template of ctx.templates) categories[template.category] = (categories[template.category] ?? 0) + 1;
    return { categories, total: ctx.templates.length, hint: '传 category 或用 search_templates 精确找' };
  }
  if (name === 'search_templates') {
    const query = String(args.query ?? '').toLowerCase();
    return ctx.templates
      .filter((template) => template.name.toLowerCase().includes(query) || template.category.toLowerCase().includes(query))
      .slice(0, 15)
      .map((template) => ({ name: template.name, category: template.category }));
  }
  const query = String(args.templateName ?? '').toLowerCase();
  const matches = ctx.templates.filter((template) => template.name.toLowerCase().includes(query));
  if (!matches.length) return { error: `no template matching "${args.templateName}"`, available: ctx.templates.map((template) => template.name) };
  const template = matches[0];
  const state = ctx.getState();
  const track = resolveTrackId(state, args.track ?? 'V1', 'video') ?? defaultTrackId(state, 'video');
  if (!track) return { error: 'no video track; create one with edit_track first' };
  const startFrame = typeof args.startFrame === 'number' ? args.startFrame : undefined;
  ctx.commands.addMotionGraphic(template, { track, startFrame, ripple: args.ripple === true });
  return { ok: true, added: template.name, trackId: track, track: trackAlias(ctx.getState(), track) };
}

function setItemTiming(args: Args, ctx: AgentContext): unknown {
  const item = findItem(ctx, args.itemId);
  if (!item) return { error: `no item ${args.itemId}` };
  if (args.startFrame !== undefined || args.durationInFrames !== undefined) {
    ctx.commands.setItemTiming(item.id, {
      startFrame: args.startFrame as number,
      durationInFrames: args.durationInFrames as number,
      ripple: args.ripple === true,
    });
  }
  const fps = ctx.getState().fps;
  const toFrames = (value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value * fps))
    : undefined;
  const fadeInFrames = toFrames(args.fadeInSeconds);
  const fadeOutFrames = toFrames(args.fadeOutSeconds);
  if (fadeInFrames !== undefined || fadeOutFrames !== undefined) {
    ctx.commands.setItemFade(item.id, { fadeInFrames, fadeOutFrames });
  }
  return {
    ok: true, itemId: item.id, ripple: args.ripple === true,
    ...(fadeInFrames !== undefined ? { fadeInFrames } : {}),
    ...(fadeOutFrames !== undefined ? { fadeOutFrames } : {}),
  };
}

function execItemMutation(name: string, args: Args, ctx: AgentContext): unknown {
  if (name === 'set_item_timing') return setItemTiming(args, ctx);
  const item = findItem(ctx, args.itemId);
  if (!item) return { error: `no item ${args.itemId}` };
  if (name === 'update_item_props') {
    ctx.commands.updateItemProps(item.id, (args.props ?? {}) as Args);
    return { ok: true, itemId: item.id, updated: Object.keys((args.props ?? {}) as Args) };
  }
  if (name === 'move_item') {
    const kind = item.kind === 'audio' ? 'audio' : 'video';
    const track = args.track === undefined ? undefined : resolveTrackId(ctx.getState(), args.track, kind);
    if (args.track !== undefined && !track) return { error: `no compatible track ${args.track}` };
    ctx.commands.moveItem(item.id, { track: track ?? undefined, startFrame: args.startFrame as number });
    return { ok: true, itemId: item.id };
  }
  if (name === 'duplicate_item') ctx.commands.duplicateItem(item.id);
  else if (name === 'remove_item' && args.ripple === true) ctx.commands.rippleDeleteItem(item.id);
  else if (name === 'remove_item') ctx.commands.removeItem(item.id);
  else if (name === 'split_item') ctx.commands.splitItem(item.id, Number(args.atFrame));
  if (name === 'duplicate_item') return { ok: true, duplicated: item.name };
  if (name === 'remove_item') return { ok: true, removed: item.name, ripple: args.ripple === true };
  return { ok: true, itemId: item.id };
}

async function generateMgCode(description: string, brandHint = ''): Promise<string> {
  const system = `You write ONE Remotion motion-graphic React component. Output ONLY the code — no markdown fences, no prose.
Contract (MUST follow exactly):
- Shape: const Name = ({item}) => { ...; return (<AbsoluteFill>...</AbsoluteFill>); };
- NO import / require / export. These globals are already injected: React, useCurrentFrame, useVideoConfig, interpolate, interpolateColors, spring, Easing, random, Img, Audio, Sequence, AbsoluteFill.
- Canvas is 1920x1080. Animate with useCurrentFrame()+interpolate()/spring({fps,frame,config}). Get { fps, durationInFrames } from useVideoConfig().
- interpolate()'s inputRange MUST be strictly increasing (e.g. [0, 15, 30]). When breakpoints are computed (per-item offsets, durationInFrames fractions), clamp with Math.max(prev + 1, next) so a later value can never be <= an earlier one — a non-monotonic inputRange throws at render time.
- Pure, synchronous rendering only. FORBIDDEN: fetch, XMLHttpRequest, WebSocket, document, window, globalThis, eval, new Function, .constructor, localStorage, setTimeout, setInterval, while(true), for(;;), debugger.
- Style inline. Make it clean and visually appealing (large readable text, tasteful colors, smooth fade/slide/scale animations).${brandHint}`;
  const result = await generateAgentText({ maxOutputTokens: 64000, system, prompt: description });
  return result.trim().replace(/^\s*```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
}

function generatedAsset(args: Args, code: string, ctx: AgentContext): MediaAsset {
  const fps = ctx.getState().fps || 30;
  const durationInFrames = typeof args.durationInFrames === 'number' && args.durationInFrames > 0
    ? Math.max(15, Math.round(args.durationInFrames))
    : Math.max(15, Math.round((Number(args.durationSeconds) || 3) * fps));
  return {
    id: crypto.randomUUID(), name: String(args.name ?? '').trim() || 'Generated MG',
    kind: 'motion-graphic', src: '', code, durationInFrames,
    width: typeof args.width === 'number' && args.width > 0 ? Math.round(args.width) : 1920,
    height: typeof args.height === 'number' && args.height > 0 ? Math.round(args.height) : 1080,
    props: {},
  };
}

async function createMotionGraphic(args: Args, ctx: AgentContext): Promise<unknown> {
  const description = String(args.prompt ?? args.description ?? '').trim();
  if (!description) return { error: 'prompt (or description) is required' };
  let code: string;
  try {
    code = await generateMgCode(description, designStyleHint(ctx.getDoc().designStyle));
  } catch (error) {
    return { error: `generation failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!code) return { error: 'model returned empty code' };
  try {
    await prepareTemplate(code);
  } catch (error) {
    return { error: `generated code rejected by sandbox: ${error instanceof Error ? error.message : String(error)}`, code };
  }
  const asset = generatedAsset(args, code, ctx);
  ctx.commands.addAsset(asset);
  return {
    ok: true, status: 'succeeded', jobId: `mg_${asset.id}`, assetId: asset.id,
    name: asset.name, kind: asset.kind, durationInFrames: asset.durationInFrames,
    width: asset.width, height: asset.height,
    note: 'Motion graphic asset is in the media pool only (submit_* contract). Place with edit_item adds:[{type:"motion-graphic",assetId:"<this assetId>",trackId?,fromFrame?}]. For catalog templates use library:motion-graphic:<templateId> or add_motion_graphic instead.',
  };
}

function execProjectMutation(name: string, args: Args, ctx: AgentContext): unknown {
  if (name === 'clear_timeline') {
    ctx.commands.clearTimeline();
    return { ok: true };
  }
  const preset = ASPECT_PRESETS.find((candidate) => candidate.label === String(args.ratio));
  if (!preset) return { error: `unknown ratio ${args.ratio}` };
  const fit = (args.fit as AspectFit) ?? ctx.getState().fit ?? 'contain';
  ctx.commands.setAspect(preset.width, preset.height, fit);
  return { ok: true, ratio: preset.label, width: preset.width, height: preset.height, fit };
}

export async function execCoreTool(
  name: string,
  args: Args,
  ctx: AgentContext,
  schemas: readonly AgentToolSchema[],
): Promise<unknown> {
  if (name === 'ToolSearch') return searchTools(args, schemas);
  if (name === 'read_timeline') return readTimeline(ctx);
  if (name === 'list_templates' || name === 'search_templates' || name === 'add_motion_graphic') {
    return execTemplateCatalog(name, args, ctx);
  }
  if (name === 'submit_motion_graphic' || name === 'create_motion_graphic') return createMotionGraphic(args, ctx);
  if (name === 'clear_timeline' || name === 'set_aspect_ratio') return execProjectMutation(name, args, ctx);
  if (['update_item_props', 'move_item', 'set_item_timing', 'duplicate_item', 'remove_item', 'split_item'].includes(name)) {
    return execItemMutation(name, args, ctx);
  }
  return { error: `unknown tool ${name}` };
}
