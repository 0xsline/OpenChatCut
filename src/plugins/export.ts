// Export as plugin (DIY closed loop): Customize the content in the session - special effects/LUT/transition,
// MG/zoom on timeline - packaged as openchatcut-plugin@1 JSON. Pure function, data is injected by the caller
// (Browser UI is in library/PluginExport.tsx), the product must pass validatePack before it can be downloaded.
import { PLUGIN_FORMAT, type PluginItem, type PluginNumberProp, type PluginPack } from './types';
import { validatePack } from './validate';
import type { FxProperty, SerializableFxDef } from '../gl/fx/uniforms';
import type { CustomTransitionDef } from '../gl/customTransitions';
import type { TimelineItem, TransitionItem } from '../editor/types';
import { zoomAt } from '../editor/zoom';

const ZOOM_EXPORT_SAMPLES = 32;

/** A selectable export candidate (item.id is uniformly rearranged by buildExportPack, occupying space here first) */
export interface ExportCandidate {
  /** Unique key within session (used in checked state) */
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

/** Custom effects candidates: only custom: (submit_shader product); plugin: (other people’s content) and builtin: not imported */
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

/** Custom LUT candidates: only custom: resources with original .cube text. */
export function lutCandidates(defs: SerializableFxDef[]): ExportCandidate[] {
  const seen = new Set<string>();
  const out: ExportCandidate[] = [];
  for (const d of defs) {
    if (!d.id.startsWith('custom:') || !d.cube || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({
      key: `lut:${d.id}`,
      label: d.name,
      item: {
        type: 'lut', id: 'lut', name: d.name, cube: d.cube,
        ...(d.desc ? { desc: d.desc.slice(0, 500) } : {}),
        ...(numberProps(d.props) ? { props: numberProps(d.props) } : {}),
      },
    });
  }
  return out;
}

/** Custom transition candidates: custom:tr-* in the registry, plus the only customFrag left on the timeline
 * (The registry is cleared after submit_shader is refreshed, and the frag only lives on TransitionItem). Press frag to remove duplicates.*/
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
    // Only uniform values, infer the conservative range of adjustable properties
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

/** Timeline MG candidates (remove duplicates by code, only one will appear if the same template is uploaded multiple times)*/
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
        ...(it.durationInFrames ? { durationInFrames: it.durationInFrames } : {}),
        ...(it.props && Object.keys(it.props).length ? { props: it.props } : {}),
      },
    });
  }
  return out;
}

/** Timeline scaling candidate: Sample the current actual curve into a portable envelope.*/
export function zoomCandidates(items: TimelineItem[]): ExportCandidate[] {
  const seen = new Set<string>();
  const out: ExportCandidate[] = [];
  for (const it of items) {
    if (!it.zoom || it.zoom.reframeCurve) continue;
    const z = it.zoom;
    const duration = Math.max(2, it.durationInFrames);
    const magnification = z.magnification ?? 1.5;
    const denominator = Math.max(0.05, magnification - 1);
    const envelope = z.envelope?.length
      ? z.envelope
      : Array.from({ length: ZOOM_EXPORT_SAMPLES }, (_, index) => {
          const frame = index * (duration - 1) / (ZOOM_EXPORT_SAMPLES - 1);
          return Number(((zoomAt(z, frame, duration).magnification - 1) / denominator).toFixed(4));
        });
    const signature = JSON.stringify({ envelope, magnification, x: z.focalPointX, y: z.focalPointY });
    if (seen.has(signature)) continue;
    seen.add(signature);
    const name = z.label ?? `${it.name} 缩放`;
    out.push({
      key: `zoom:${it.id}`,
      label: name,
      item: {
        type: 'zoom', id: 'zoom', name, envelope, magnification,
        ...(z.focalPointX != null ? { focalPointX: z.focalPointX } : {}),
        ...(z.focalPointY != null ? { focalPointY: z.focalPointY } : {}),
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

/** Group package: Each type of content is rearranged with a unique ID (fx-1/tr-1/mg-1...), and the entire package is released only after passing validatePack.*/
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
