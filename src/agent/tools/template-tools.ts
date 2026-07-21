import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { DesignStyle, ProjectDoc, Timeline, TimelineItem, TrackId } from '../../editor/types';
import { activeTimeline, resolveTrackId, timelineTrackIds, trackKind } from '../../editor/types';
import { migrateProjectDoc } from '../../persist/projectStore';
import { listTemplates, getTemplate, saveTemplate, type ProjectTemplate } from '../../persist/templateStore';

// manage_template — 工程模板。模板 = 一组 MG + 设计风格的打包。
// action: get / list_assets / apply / copy_assets / save。
// 语义:apply 前先 list_assets 决定「套用现成 vs 重新生成」。
// save:把当前工程打包存为模板。
// apply 经 ctx.commands.applyDoc 单步原子提交，形成一次可撤销的时间线整体变更。

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
    '工程模板 = 一组 MG(动态图形)+ 设计风格的打包,可跨工程复用。',
    'action: get | list_assets | apply | copy_assets | save.',
    'get(不带 templateId)=列出所有已存模板(id/name/资产数);get(带 templateId)=查看某模板详情(MG 列表 + 设计风格摘要 + 资产数)。',
    'list_assets(带 templateId)=列出该模板携带的媒体资产(id/name/kind),据此决定套用现成 vs 重新生成——apply 前应先 list_assets。',
    'apply(带 templateId)=把模板套用到当前工程。placement 可用 append/replace,也可指定 startFrame、durationInFrames、targetTrackId 精确落位;omitAssetIds 跳过这些携带资产及引用它们的片段。',
    'copy_assets(带 templateId)=只把模板资产复制进当前工程,返回新生成的工程本地 asset id,不放置模板时间线。',
    'save(带 name)=把当前工程打包保存为模板(同名覆盖)。',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'list_assets', 'apply', 'copy_assets', 'save'] },
      templateId: { type: 'string', description: 'get(详情)/list_assets/apply/copy_assets 的目标模板 id;用 get(无参)先列出。' },
      placement: {
        description: 'apply: append/replace,或用对象指定起始帧、目标总时长和目标主轨道。',
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
      omitAssetIds: { type: 'array', items: { type: 'string' }, description: 'apply: 跳过这些携带资产(及直接引用它们的片段)。' },
      name: { type: 'string', description: 'save: 模板名称(必填;同名覆盖)。' },
    },
    required: ['action'],
  },
}];

export const TEMPLATE_TOOL_NAMES = new Set(TEMPLATE_TOOL_SCHEMAS.map((t) => t.name));

const summarizeStyle = (s: DesignStyle | undefined) =>
  s ? { colors: s.colors, fonts: s.fonts, styleGuide: s.styleGuide ?? null } : null;

/** 模板详情摘要:各时间线的 MG 片段 + 设计风格 + 计数(证明打包的 doc 完整回带)。 */
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

/** 重新分配片段 id(避免二次 apply 与现有片段 id 撞车),返回 old→new 映射。 */
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

/** 按新片段 id 重连过渡;引用了被丢弃片段的过渡直接丢掉(不留悬空引用)。 */
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

/** 把模板的活动时间线内容放入当前活动时间线:保留工程的画幅/身份,只换片段/轨道/过渡。 */
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
      ...active, // 保留 id/name/order/fps/画幅/captions
      items,
      trackOrder: tplActive.trackOrder,
      tracks: tplActive.tracks,
      transitions: remapTransitions(tplActive.transitions, map),
      markers: active.markers?.filter((m) => m.scope === 'project'), // item 级标记的片段已被替换,丢弃
    };
  }
  // append:模板片段整体后移到当前内容之后,轨道并入
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

/** 把模板合并进当前工程,产出一份完整 ProjectDoc(交给 applyDoc 原子提交)。 */
function mergeTemplate(current: ProjectDoc, tpl: ProjectTemplate, placement: TemplatePlacement, omit: Set<string>): ProjectDoc {
  const tplDoc = tpl.doc;
  // 被跳过的资产 → 其 src 集合,用于连带跳过引用它们的片段
  const omittedSrcs = new Set(tplDoc.assets.filter((a) => omit.has(a.id) && a.src).map((a) => a.src));
  const keepItem = (it: TimelineItem): boolean =>
    !(it.templateId && omit.has(it.templateId)) && !(it.src && omittedSrcs.has(it.src));

  const tplActive = activeTimeline(tplDoc);
  const keptItems = tplActive.items.filter(keepItem);
  const active = activeTimeline(current);
  const nextActive = applyPlacement(active, tplActive, keptItems, placement);

  const carriedAssets = tplDoc.assets.filter((a) => !omit.has(a.id));
  const designStyle = tplDoc.designStyle ?? current.designStyle; // 模板携带设计风格,套用它

  return {
    version: 2,
    // current 在前:同 id 资产以当前工程为准(dedupeAssets 保留首个)
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
      // 模板文档不可信:合并后再过一遍 migrateProjectDoc(去重资产、清悬空引用、校验形状)
      let merged: ProjectDoc;
      try {
        merged = mergeTemplate(ctx.getDoc(), tpl, placement, omit);
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'template placement failed' };
      }
      const clean = migrateProjectDoc(merged);
      if (!clean) return { error: 'template produced an invalid project doc' };
      ctx.commands.applyDoc(clean); // 一次原子、可撤销的时间线整体变更。
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
      // 模板打包的就是整份 ProjectDoc(时间线含 MG + designStyle + 资产池) = ctx.getDoc()
      const saved = await saveTemplate(styleName, ctx.getDoc());
      return { ok: true, saved: { id: saved.id, name: saved.name, assetCount: saved.assetIds.length } };
    }

    default:
      return { error: `unknown action "${action}"; use get|list_assets|apply|copy_assets|save` };
  }
}
