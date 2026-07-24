import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { DesignStyle, ProjectDoc, Timeline, TimelineItem, TrackId } from '../../editor/types';
import { activeTimeline, resolveTrackId, timelineTrackIds, trackKind } from '../../editor/types';
import { migrateProjectDoc } from '../../persist/projectStore';
import { listTemplates, getTemplate, saveTemplate, type ProjectTemplate } from '../../persist/templateStore';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';

// manage_template — Project template. Template = a set of MG + design styles packaged.
// action: get / list_assets / apply / copy_assets / save。
// Semantics: list_assets is used before applying to decide "apply existing vs regenerated".
// save: Package and save the current project as a template.
// apply is submitted atomically in a single step via ctx.commands.applyDoc, forming a reversible change to the entire timeline.

type Args = Record<string, unknown>;
export interface ExactTemplatePlacement {
  startFrame?: number;
  durationInFrames?: number;
  targetTrackId?: string;
}
export type TemplatePlacement = 'append' | 'replace' | ExactTemplatePlacement;

export const TEMPLATE_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_template',
  description: [
    'Project template = a group MG(motion graphics)+ Design style packaging,Can be reused across projects.',
    'action: get | list_assets | apply | copy_assets | save.',
    'get(Without templateId)=List all saved templates(id/name/Number of assets);get(bring templateId)=View details of a template(MG list + Design style summary + Number of assets)。',
    'list_assets(bring templateId)=List the media assets carried by this template(id/name/kind),Based on this, it was decided to apply the ready-made vs Regenerate——apply should first list_assets。',
    'apply(bring templateId)=Apply the template to the current project.placement Available append/replace,Can also be specified startFrame、durationInFrames、targetTrackId Precise placement;omitAssetIds Skip these fragments that carry assets and reference them.',
    'copy_assets(bring templateId)=Only copy template assets into the current project,Return to the newly generated project local asset id,Template timeline is not placed.',
    'save(bring name)=Package and save the current project as a template(Coverage with the same name)。',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'list_assets', 'apply', 'copy_assets', 'save'] },
      templateId: { type: 'string', description: 'get(Details)/list_assets/apply/copy_assets target template id;use get(No ginseng)List first.' },
      placement: {
        description: 'apply: append/replace,Or use objects to specify the start frame, target total duration, and target master track.',
        oneOf: [
          { type: 'string', enum: ['append', 'replace'] },
          {
            type: 'object',
            properties: {
              startFrame: { type: 'integer', minimum: 0 },
              durationInFrames: { type: 'integer', exclusiveMinimum: 0 },
              targetTrackId: { type: 'string' },
            },
            additionalProperties: false,
          },
        ],
      },
      omitAssetIds: { type: 'array', items: { type: 'string' }, description: 'apply: Skip these carrying assets(and fragments that directly reference them)。' },
      name: { type: 'string', description: 'save: Template name(Required;Coverage with the same name)。' },
    },
    required: ['action'],
  },
}];

export const TEMPLATE_TOOL_NAMES = new Set(TEMPLATE_TOOL_SCHEMAS.map((t) => t.name));

const summarizeStyle = (s: DesignStyle | undefined) =>
  s ? { colors: s.colors, fonts: s.fonts, styleGuide: s.styleGuide ?? null } : null;

/** Summary of template details:of each timeline MG fragment + design style + count(Proof of packaging doc Complete playback)。 */
function templateDetail(tpl: ProjectTemplate) {
  const motionGraphics = tpl.doc.timelines
    .flatMap((t) => t.items)
    .filter((it) => it.kind === 'motion-graphic')
    .map((it) => ({ name: it.name, templateId: it.templateId ?? null, durationInFrames: it.durationInFrames }));
  return {
    id: tpl.id,
    name: tpl.name,
    motionGraphics,
    designStyle: summarizeStyle(tpl.doc.designStyle),
    timelineCount: tpl.doc.timelines.length,
    assetCount: tpl.assetIds.length,
  };
}

const uid = (p: string) => `${p}_${crypto.randomUUID()}`;

/** Reassign fragments id(avoid a second time apply with existing fragment id crash),Return old→new mapping. */
function reIdItems(items: TimelineItem[], offsetFrames: number): { items: TimelineItem[]; map: Map<string, string> } {
  const map = new Map<string, string>();
  const out = items.map((it) => {
    const id = uid('item');
    map.set(it.id, id);
    return { ...it, id, startFrame: it.startFrame + offsetFrames };
  });
  return { items: out, map };
}

interface TransitionRemapOptions {
  scale?: number;
  track?: (id: TrackId) => TrackId;
  items?: TimelineItem[];
}

/** press new clip id reconnect transition;Transitions that reference discarded fragments are discarded directly.(Leave no dangling references)。 */
function remapTransitions(
  source: Timeline['transitions'],
  map: Map<string, string>,
  options: TransitionRemapOptions = {},
): NonNullable<Timeline['transitions']> {
  const items = new Map((options.items ?? []).map((item) => [item.id, item]));
  const scale = options.scale ?? 1;
  return (source ?? []).flatMap((tr) => {
    const outgoing = map.get(tr.outgoingItemId);
    const incoming = map.get(tr.incomingItemId);
    if (!outgoing || !incoming) return [];
    const outgoingDuration = items.get(outgoing)?.durationInFrames ?? Number.MAX_SAFE_INTEGER;
    const incomingDuration = items.get(incoming)?.durationInFrames ?? Number.MAX_SAFE_INTEGER;
    const durationInFrames = Math.max(1, Math.min(
      Math.round(tr.durationInFrames * scale),
      outgoingDuration,
      incomingDuration,
    ));
    return [{
      ...tr,
      id: uid('tr'),
      durationInFrames,
      outgoingItemId: outgoing,
      incomingItemId: incoming,
      trackId: options.track?.(tr.trackId) ?? tr.trackId,
    }];
  });
}

/** Put the template's activity timeline content into the current activity timeline:Keep the project frame/identity,Change only the fragments/Orbit/Transition. */
function resolvePlacementTrack(active: Timeline, ref: string, kind?: ReturnType<typeof trackKind>): TrackId | null {
  return resolveTrackId(active, ref, kind)
    ?? timelineTrackIds(active).find((id) => (!kind || trackKind(active, id) === kind) && id.startsWith(ref))
    ?? null;
}

function exactItems(
  items: TimelineItem[],
  placement: ExactTemplatePlacement,
  sourceTrack: TrackId | undefined,
  targetTrack: TrackId | undefined,
  defaultStart: number,
): { items: TimelineItem[]; map: Map<string, string>; scale: number } {
  if (!items.length) return { items: [], map: new Map(), scale: 1 };
  const sourceStart = items.reduce((min, item) => Math.min(min, item.startFrame), Infinity);
  const sourceEnd = items.reduce((max, item) => Math.max(max, item.startFrame + item.durationInFrames), sourceStart + 1);
  const sourceDuration = Math.max(1, sourceEnd - sourceStart);
  const startFrame = placement.startFrame ?? defaultStart;
  const scale = placement.durationInFrames ? placement.durationInFrames / sourceDuration : 1;
  const map = new Map<string, string>();
  const placed = items.map((item) => {
    const id = uid('item');
    const start = startFrame + Math.round((item.startFrame - sourceStart) * scale);
    const end = startFrame + Math.round((item.startFrame + item.durationInFrames - sourceStart) * scale);
    map.set(item.id, id);
    const durationInFrames = Math.max(1, end - start);
    const maxLocalFrame = Math.max(0, durationInFrames - 1);
    const scaleFrame = (frame: number) => Math.min(maxLocalFrame, Math.max(0, Math.round(frame * scale)));
    const keyframes = item.keyframes
      ? Object.fromEntries(Object.entries(item.keyframes).map(([prop, frames]) => [
          prop,
          frames?.map((keyframe) => ({ ...keyframe, frame: scaleFrame(keyframe.frame) })),
        ])) as TimelineItem['keyframes']
      : undefined;
    const zoom = item.zoom
      ? {
          ...item.zoom,
          easeInFrames: item.zoom.easeInFrames == null ? undefined : scaleFrame(item.zoom.easeInFrames),
          easeOutFrames: item.zoom.easeOutFrames == null ? undefined : scaleFrame(item.zoom.easeOutFrames),
          reframeCurve: item.zoom.reframeCurve
            ? {
                ...item.zoom.reframeCurve,
                keyframes: item.zoom.reframeCurve.keyframes.map((keyframe) => ({
                  ...keyframe,
                  frame: scaleFrame(keyframe.frame),
                })),
              }
            : undefined,
        }
      : undefined;
    return {
      ...item,
      id,
      track: sourceTrack && targetTrack && item.track === sourceTrack ? targetTrack : item.track,
      startFrame: start,
      durationInFrames,
      ...(item.kind === 'video' || item.kind === 'audio'
        ? { playbackRate: (item.playbackRate ?? 1) / scale }
        : {}),
      ...(item.fadeInFrames == null ? {} : { fadeInFrames: Math.min(durationInFrames, Math.max(0, Math.round(item.fadeInFrames * scale))) }),
      ...(item.fadeOutFrames == null ? {} : { fadeOutFrames: Math.min(durationInFrames, Math.max(0, Math.round(item.fadeOutFrames * scale))) }),
      ...(keyframes ? { keyframes } : {}),
      ...(zoom ? { zoom } : {}),
    };
  });
  return { items: placed, map, scale };
}

export function applyPlacement(active: Timeline, tplActive: Timeline, keptItems: TimelineItem[], placement: TemplatePlacement): Timeline {
  if (placement === 'replace') {
    const { items, map } = reIdItems(keptItems, 0);
    return {
      ...active, // Reserve id/name/order/fps/frame/captions
      items,
      trackOrder: tplActive.trackOrder,
      tracks: tplActive.tracks,
      transitions: remapTransitions(tplActive.transitions, map),
      markers: active.markers?.filter((m) => m.scope === 'project'), // Fragments of item-level tags have been replaced and discarded
    };
  }
  // append: The entire template fragment is moved behind the current content and the track is merged
  const end = active.items.reduce((m, it) => Math.max(m, it.startFrame + it.durationInFrames), 0);
  if (typeof placement === 'object') {
    const sourceTrack = (tplActive.trackOrder ?? []).find((id) => keptItems.some((item) => item.track === id))
      ?? keptItems[0]?.track;
    const sourceKind = sourceTrack ? trackKind(tplActive, sourceTrack) : undefined;
    const targetTrack = placement.targetTrackId
      ? resolvePlacementTrack(active, placement.targetTrackId, sourceKind)
      : undefined;
    if (placement.targetTrackId && !targetTrack) {
      throw new Error(`target track "${placement.targetTrackId}" not found or has the wrong kind`);
    }
    const { items, map, scale } = exactItems(keptItems, placement, sourceTrack, targetTrack ?? undefined, end);
    const remapTrack = (id: TrackId): TrackId => sourceTrack && targetTrack && id === sourceTrack ? targetTrack : id;
    const tracks = { ...(active.tracks ?? {}) };
    for (const [id, flags] of Object.entries(tplActive.tracks ?? {})) {
      const mappedId = remapTrack(id);
      if (!tracks[mappedId]) tracks[mappedId] = flags;
    }
    const order = [...(active.trackOrder ?? [])];
    for (const id of tplActive.trackOrder ?? []) {
      const mappedId = remapTrack(id);
      if (!order.includes(mappedId)) order.push(mappedId);
    }
    return {
      ...active,
      items: [...active.items, ...items],
      tracks,
      trackOrder: order,
      transitions: [
        ...(active.transitions ?? []),
        ...remapTransitions(tplActive.transitions ?? [], map, { scale, track: remapTrack, items }),
      ],
    };
  }
  const { items, map } = reIdItems(keptItems, end);
  const curOrder = active.trackOrder ?? [];
  const tplOrder = tplActive.trackOrder ?? [];
  return {
    ...active,
    items: [...active.items, ...items],
    tracks: { ...active.tracks, ...tplActive.tracks },
    trackOrder: [...curOrder, ...tplOrder.filter((id) => !curOrder.includes(id))],
    transitions: [...(active.transitions ?? []), ...remapTransitions(tplActive.transitions ?? [], map)],
  };
}

/** Merge template into current project,Produce a complete ProjectDoc(hand over applyDoc Atomic commit)。 */
function mergeTemplate(current: ProjectDoc, tpl: ProjectTemplate, placement: TemplatePlacement, omit: Set<string>): ProjectDoc {
  const tplDoc = tpl.doc;
  // Skipped assets → their src collection, used to skip fragments that reference them
  const omittedSrcs = new Set(tplDoc.assets.filter((a) => omit.has(a.id) && a.src).map((a) => a.src));
  const keepItem = (it: TimelineItem): boolean =>
    !(it.templateId && omit.has(it.templateId)) && !(it.src && omittedSrcs.has(it.src));

  const tplActive = activeTimeline(tplDoc);
  const keptItems = tplActive.items.filter(keepItem);
  const active = activeTimeline(current);
  const nextActive = applyPlacement(active, tplActive, keptItems, placement);

  const carriedAssets = tplDoc.assets.filter((a) => !omit.has(a.id));
  const designStyle = tplDoc.designStyle ?? current.designStyle; // The template carries the design style, apply it

  return {
    version: CURRENT_PROJECT_VERSION,
    // current first: assets with the same id are subject to the current project (dedupeAssets retains the first one)
    assets: [...current.assets, ...carriedAssets],
    mediaFolders: current.mediaFolders,
    timelines: current.timelines.map((t) => (t.id === active.id ? nextActive : t)),
    activeTimelineId: current.activeTimelineId,
    ...(designStyle ? { designStyle } : {}),
  };
}

export function copyTemplateAssets(current: ProjectDoc, tpl: ProjectTemplate) {
  const carried = new Set(tpl.assetIds);
  const copied = tpl.doc.assets.filter((asset) => carried.has(asset.id)).map((asset) => {
    const assetId = uid('asset');
    return {
      asset: { ...asset, id: assetId, folderId: undefined },
      result: { templateAssetId: asset.id, assetId, name: asset.name, kind: asset.kind },
    };
  });
  return {
    doc: { ...current, assets: [...current.assets, ...copied.map(({ asset }) => asset)] },
    assets: copied.map(({ result }) => result),
  };
}

function parsePlacement(value: unknown): { placement?: TemplatePlacement; error?: string } {
  if (value === undefined || value === 'append') return { placement: 'append' };
  if (value === 'replace') return { placement: 'replace' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'placement must be append, replace, or an object' };
  const raw = value as Record<string, unknown>;
  if (raw.startFrame !== undefined && (!Number.isSafeInteger(raw.startFrame) || Number(raw.startFrame) < 0)) {
    return { error: 'placement.startFrame must be a non-negative integer' };
  }
  if (raw.durationInFrames !== undefined && (!Number.isSafeInteger(raw.durationInFrames) || Number(raw.durationInFrames) <= 0)) {
    return { error: 'placement.durationInFrames must be a positive integer' };
  }
  if (raw.targetTrackId !== undefined && (typeof raw.targetTrackId !== 'string' || !raw.targetTrackId.trim())) {
    return { error: 'placement.targetTrackId must be a non-empty string' };
  }
  return { placement: {
    ...(raw.startFrame !== undefined ? { startFrame: Number(raw.startFrame) } : {}),
    ...(raw.durationInFrames !== undefined ? { durationInFrames: Number(raw.durationInFrames) } : {}),
    ...(typeof raw.targetTrackId === 'string' ? { targetTrackId: raw.targetTrackId.trim() } : {}),
  } };
}

const strArg = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export async function execTemplateTool(name: string, args: Args, ctx: AgentContext): Promise<unknown> {
  if (name !== 'manage_template') return { error: `unknown tool ${name}` };
  const action = String(args.action ?? '');

  switch (action) {
    case 'get': {
      const id = strArg(args.templateId);
      if (!id) {
        const all = await listTemplates();
        return { templates: all.map((t) => ({ id: t.id, name: t.name, assetCount: t.assetIds.length })) };
      }
      const tpl = await getTemplate(id);
      if (!tpl) return { error: `no template "${id}"` };
      return { template: templateDetail(tpl) };
    }

    case 'list_assets': {
      const id = strArg(args.templateId);
      if (!id) return { error: 'list_assets requires "templateId"' };
      const tpl = await getTemplate(id);
      if (!tpl) return { error: `no template "${id}"` };
      const carried = new Set(tpl.assetIds);
      const assets = tpl.doc.assets
        .filter((a) => carried.has(a.id))
        .map((a) => ({ id: a.id, name: a.name, kind: a.kind }));
      return { templateId: id, assets };
    }

    case 'apply': {
      const id = strArg(args.templateId);
      if (!id) return { error: 'apply requires "templateId"' };
      const tpl = await getTemplate(id);
      if (!tpl) return { error: `no template "${id}"` };
      const parsed = parsePlacement(args.placement);
      if (!parsed.placement) return { error: parsed.error };
      const placement = parsed.placement;
      const omit = new Set(Array.isArray(args.omitAssetIds) ? (args.omitAssetIds as unknown[]).filter((x): x is string => typeof x === 'string') : []);
      // The template document is not trustworthy: go through migrateProjectDoc again after merging (removing duplicate assets, clearing dangling references, and verifying shapes)
      let merged: ProjectDoc;
      try {
        merged = mergeTemplate(ctx.getDoc(), tpl, placement, omit);
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'template placement failed' };
      }
      const clean = migrateProjectDoc(merged);
      if (!clean) return { error: 'template produced an invalid project doc' };
      ctx.commands.applyDoc(clean); // An atomic, undoable change to the entire timeline.
      return { ok: true, applied: true, templateId: id, placement };
    }

    case 'copy_assets': {
      const id = strArg(args.templateId);
      if (!id) return { error: 'copy_assets requires "templateId"' };
      const tpl = await getTemplate(id);
      if (!tpl) return { error: `no template "${id}"` };
      const copied = copyTemplateAssets(ctx.getDoc(), tpl);
      const clean = migrateProjectDoc(copied.doc);
      if (!clean) return { error: 'template assets produced an invalid project doc' };
      if (copied.assets.length) ctx.commands.applyDoc(clean);
      return { ok: true, templateId: id, assets: copied.assets };
    }

    case 'save': {
      const styleName = strArg(args.name);
      if (!styleName) return { error: 'save requires a non-empty "name"' };
      // The template is packaged with the entire ProjectDoc (timeline including MG + designStyle + asset pool) = ctx.getDoc()
      const saved = await saveTemplate(styleName, ctx.getDoc());
      return { ok: true, saved: { id: saved.id, name: saved.name, assetCount: saved.assetIds.length } };
    }

    default:
      return { error: `unknown action "${action}"; use get|list_assets|apply|copy_assets|save` };
  }
}
