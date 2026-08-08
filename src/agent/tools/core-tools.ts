import type { AgentContext } from '../context';
import type { AgentToolSchema } from '../tool-schema';
import { defaultTrackId, resolveTrackId, trackAlias } from '../../editor/types';
import type { MediaAsset } from '../../editor/types';
import { prepareTemplate } from '../../template-host';
import { generateAgentText } from '../client';
import { designStyleHint } from '../systemPrompt';
import { execCoreDataTool } from './core-data-tools';

type Args = Record<string, unknown>;

function searchTools(args: Args, schemas: readonly AgentToolSchema[]): unknown {
  const query = String(args.query ?? '').trim().toLowerCase();
  if (!query) return { error: 'query is required', results: [] };
  const limit = Math.min(12, Math.max(1, Math.round(Number(args.limit) || 8)));
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
  const results = scored.map(({ tool }) => ({
    name: tool.name,
    description: (tool.description ?? '').slice(0, 280),
  }));
  return {
    query,
    count: results.length,
    results,
    activatedTools: results.map((tool) => tool.name),
    note: results.length
      ? 'Matching schemas are active for the next model step. Call tools by exact name.'
      : 'No tools matched; try export / caption / stock / video / voice.',
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

export async function execCoreTool(
  name: string,
  args: Args,
  ctx: AgentContext,
  schemas: readonly AgentToolSchema[],
): Promise<unknown> {
  if (name === 'ToolSearch') return searchTools(args, schemas);
  const dataResult = execCoreDataTool(name, args, ctx);
  if (dataResult !== undefined) return dataResult;
  if (name === 'list_templates' || name === 'search_templates' || name === 'add_motion_graphic') {
    return execTemplateCatalog(name, args, ctx);
  }
  if (name === 'submit_motion_graphic' || name === 'create_motion_graphic') return createMotionGraphic(args, ctx);
  return { error: `unknown tool ${name}` };
}
