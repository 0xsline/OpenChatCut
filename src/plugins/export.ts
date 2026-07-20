// 导出为插件(DIY 闭环):把会话内自定义内容——submit_shader 生成的特效/转场、
// 时间线上的 MG 片段——打包成 openchatcut-plugin@1 JSON。纯函数,数据由调用方注入
// (浏览器 UI 在 library/PluginExport.tsx),产物必过 validatePack 才允许下载。
import { PLUGIN_FORMAT, type PluginItem, type PluginNumberProp, type PluginPack } from './types';
import { validatePack } from './validate';
import type { FxProperty, SerializableFxDef } from '../gl/fx/uniforms';
import type { CustomTransitionDef } from '../gl/customTransitions';
import type { TimelineItem, TransitionItem } from '../editor/types';

/** 一个可勾选的导出候选(item.id 由 buildExportPack 统一重排,这里先占位) */
export interface ExportCandidate {
  /** 会话内唯一键(勾选状态用) */
  key: string;
  label: string;
  item: PluginItem;
}

function numberProps(props: FxProperty[] | undefined): PluginNumberProp[] | undefined {
  if (!props?.length) return undefined;
  const out = props
    .filter((p) => p.kind !== 'color')
    .map((p) => ({ key: p.key, label: p.label, default: p.default as number, min: (p as { min: number }).min, max: (p as { max: number }).max, ...(p.step ? { step: p.step } : {}) }));
  return out.length ? out : undefined;
}

/** 自定义特效候选:只收 custom:(submit_shader 产物);plugin:(他人内容)与 builtin: 不导 */
export function fxCandidates(defs: SerializableFxDef[]): ExportCandidate[] {
  const seen = new Set<string>();
  const out: ExportCandidate[] = [];
  for (const d of defs) {
    if (!d.id.startsWith('custom:') || d.cube || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({
      key: d.id,
      label: d.name,
      item: {
        type: 'fx', id: 'fx', name: d.name,
        ...(d.desc ? { desc: d.desc.slice(0, 500) } : {}),
        frag: d.frag,
        ...(numberProps(d.props) ? { props: numberProps(d.props) } : {}),
        ...(d.passes ? { passes: d.passes } : {}),
      },
    });
  }
  return out;
}

/** 自定义转场候选:注册表里的 custom:tr-*,加上时间线上仅存 customFrag 的
 * (submit_shader 刷新后注册表清空,frag 只活在 TransitionItem 上)。按 frag 去重。 */
export function transitionCandidates(defs: CustomTransitionDef[], transitions: TransitionItem[]): ExportCandidate[] {
  const seenFrag = new Set<string>();
  const out: ExportCandidate[] = [];
  for (const d of defs) {
    if (!d.id.startsWith('custom:') || seenFrag.has(d.frag)) continue;
    seenFrag.add(d.frag);
    out.push({
      key: d.id,
      label: d.label,
      item: {
        type: 'transition', id: 'tr', name: d.label, frag: d.frag,
        ...(d.props.length ? { props: d.props.map((p) => ({ key: p.key, label: p.label, default: p.default, min: p.min, max: p.max, ...(p.step ? { step: p.step } : {}) })) } : {}),
      },
    });
  }
  for (const t of transitions) {
    if (t.type !== 'custom-shader' || !t.customFrag || seenFrag.has(t.customFrag)) continue;
    seenFrag.add(t.customFrag);
    const name = t.customLabel ?? '自定义转场';
    // 仅有 uniform 值,反推可调属性的保守范围
    const props: PluginNumberProp[] = Object.entries(t.customUniforms ?? {}).map(([k, v]) => ({
      key: k.replace(/^u_/, ''),
      label: k.replace(/^u_/, ''),
      default: v,
      min: Math.min(0, v),
      max: v === 0 ? 1 : Math.max(1, Math.abs(v) * 2),
    }));
    out.push({
      key: `timeline:${t.id}`,
      label: name,
      item: { type: 'transition', id: 'tr', name, frag: t.customFrag, ...(props.length ? { props } : {}) },
    });
  }
  return out;
}

/** 时间线 MG 候选(按 code 去重,同模板多次上轨只出一条) */
export function mgCandidates(items: TimelineItem[]): ExportCandidate[] {
  const seenCode = new Set<string>();
  const out: ExportCandidate[] = [];
  for (const it of items) {
    if (it.kind !== 'motion-graphic' || !it.code || seenCode.has(it.code)) continue;
    seenCode.add(it.code);
    out.push({
      key: `mg:${it.id}`,
      label: it.name,
      item: {
        type: 'mg-template', id: 'mg', name: it.name, code: it.code,
        ...(it.width ? { width: it.width } : {}),
        ...(it.height ? { height: it.height } : {}),
        ...(it.props && Object.keys(it.props).length ? { props: it.props } : {}),
      },
    });
  }
  return out;
}

export interface ExportMeta {
  id: string;
  name: string;
  version?: string;
  author?: string;
  description?: string;
}

export type BuildResult = { ok: true; pack: PluginPack; json: string } | { ok: false; errors: string[] };

/** 组包:每类内容重排唯一 id(fx-1/tr-1/mg-1…),整包过 validatePack 才放行。 */
export function buildExportPack(meta: ExportMeta, selected: PluginItem[]): BuildResult {
  const counters: Record<string, number> = {};
  const items = selected.map((item) => {
    const prefix = item.type === 'mg-template' ? 'mg' : item.type === 'transition' ? 'tr' : item.type;
    counters[prefix] = (counters[prefix] ?? 0) + 1;
    return { ...item, id: `${prefix}-${counters[prefix]}` };
  });
  const pack = {
    format: PLUGIN_FORMAT,
    id: meta.id.trim(),
    name: meta.name.trim(),
    version: meta.version?.trim() || '1.0.0',
    ...(meta.author?.trim() ? { author: meta.author.trim() } : {}),
    ...(meta.description?.trim() ? { description: meta.description.trim() } : {}),
    items,
  };
  const res = validatePack(pack);
  if (!res.ok) return { ok: false, errors: res.errors };
  return { ok: true, pack: res.pack, json: JSON.stringify(res.pack, null, 2) };
}
