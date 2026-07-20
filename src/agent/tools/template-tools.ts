import type { AgentToolSchema } from '../tool-schema';
import type { AgentContext } from '../context';
import type { DesignStyle, ProjectDoc, Timeline, TimelineItem } from '../../editor/types';
import { activeTimeline } from '../../editor/types';
import { migrateProjectDoc } from '../../persist/projectStore';
import { listTemplates, getTemplate, saveTemplate, type ProjectTemplate } from '../../persist/templateStore';

// manage_template — 工程模板。模板 = 一组 MG + 设计风格的打包。
// action: get / list_assets / apply(参数 templateId / placement / omitAssetIds)。
// 语义:apply 前先 list_assets 决定「套用现成 vs 重新生成」。
// save:把当前工程打包存为模板。
// apply 经 ctx.commands.applyDoc 单步原子提交，形成一次可撤销的时间线整体变更。

type Args = Record<string, unknown>;
type Placement = 'append' | 'replace';

export const TEMPLATE_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'manage_template',
  description: [
    '工程模板 = 一组 MG(动态图形)+ 设计风格的打包,可跨工程复用。',
    'action: get | list_assets | apply | save.',
    'get(不带 templateId)=列出所有已存模板(id/name/资产数);get(带 templateId)=查看某模板详情(MG 列表 + 设计风格摘要 + 资产数)。',
    'list_assets(带 templateId)=列出该模板携带的媒体资产(id/name/kind),据此决定套用现成 vs 重新生成——apply 前应先 list_assets。',
    'apply(带 templateId)=把模板套用到当前工程:placement=append(追加到活动时间线末尾,默认)或 replace(替换活动时间线内容);omitAssetIds 跳过这些携带资产及引用它们的片段("这些我要重新生成")。',
    'save(带 name)=把当前工程打包保存为模板(同名覆盖)。',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'list_assets', 'apply', 'save'] },
      templateId: { type: 'string', description: 'get(详情)/list_assets/apply 的目标模板 id;用 get(无参)先列出。' },
      placement: { type: 'string', enum: ['append', 'replace'], description: 'apply: append=追加到活动时间线末尾(默认);replace=替换活动时间线内容。' },
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

/** 按新片段 id 重连过渡;引用了被丢弃片段的过渡直接丢掉(不留悬空引用)。 */
function remapTransitions(source: Timeline['transitions'], map: Map<string, string>): NonNullable<Timeline['transitions']> {
  return (source ?? []).flatMap((tr) => {
    const outgoing = map.get(tr.outgoingItemId);
    const incoming = map.get(tr.incomingItemId);
    return outgoing && incoming ? [{ ...tr, id: uid('tr'), outgoingItemId: outgoing, incomingItemId: incoming }] : [];
  });
}

/** 把模板的活动时间线内容放入当前活动时间线:保留工程的画幅/身份,只换片段/轨道/过渡。 */
function applyPlacement(active: Timeline, tplActive: Timeline, keptItems: TimelineItem[], placement: Placement): Timeline {
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
function mergeTemplate(current: ProjectDoc, tpl: ProjectTemplate, placement: Placement, omit: Set<string>): ProjectDoc {
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
      const placement: Placement = args.placement === 'replace' ? 'replace' : 'append';
      const omit = new Set(Array.isArray(args.omitAssetIds) ? (args.omitAssetIds as unknown[]).filter((x): x is string => typeof x === 'string') : []);
      // 模板文档不可信:合并后再过一遍 migrateProjectDoc(去重资产、清悬空引用、校验形状)
      const clean = migrateProjectDoc(mergeTemplate(ctx.getDoc(), tpl, placement, omit));
      if (!clean) return { error: 'template produced an invalid project doc' };
      ctx.commands.applyDoc(clean); // 一次原子、可撤销的时间线整体变更。
      return { ok: true, applied: true, templateId: id, placement };
    }

    case 'save': {
      const styleName = strArg(args.name);
      if (!styleName) return { error: 'save requires a non-empty "name"' };
      // 模板打包的就是整份 ProjectDoc(时间线含 MG + designStyle + 资产池) = ctx.getDoc()
      const saved = await saveTemplate(styleName, ctx.getDoc());
      return { ok: true, saved: { id: saved.id, name: saved.name, assetCount: saved.assetIds.length } };
    }

    default:
      return { error: `unknown action "${action}"; use get|list_assets|apply|save` };
  }
}
