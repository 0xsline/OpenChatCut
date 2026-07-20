// Library catalog for browse_library — categories:
// motion-graphics | luts | zoom | fx | audio-fx | sound-effects | transitions
// audio-fx: open-box isolate_voice (ffmpeg), applied via isolate_voice tool / Inspector.

import { SOUND_EFFECTS } from '../../audio/soundLibrary';
import {
  TRANSITION_LABELS,
  TRANSITION_ORDER,
  ZOOM_SHAPE_LABELS,
  ZOOM_SHAPE_ORDER,
  type TransitionType,
  type ZoomShape,
} from '../../editor/types';
import { CUSTOM_FX, FX_EFFECTS, FX_IDS, LUT_EFFECTS, LUT_IDS } from '../../gl/fx/effects';
import { listCustomTransitions } from '../../gl/customTransitions';
import { listCustomZooms } from '../../editor/customZooms';
import type { Tpl } from '../../types';
import {
  AUDIO_FX_ISOLATE_DEFAULT,
  AUDIO_FX_ISOLATE_LIGHT,
  AUDIO_FX_ISOLATE_STRONG,
} from '../../audio/isolateVoice';

export const LIBRARY_CATEGORIES = [
  'motion-graphics',
  'luts',
  'zoom',
  'fx',
  'audio-fx',
  'sound-effects',
  'transitions',
] as const;

export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

export interface LibraryItem {
  id: string;
  name: string;
  category: LibraryCategory;
  description: string;
  group?: string;
  /** Placement guidance for edit_item. */
  usage?: string;
}

/** Map TransitionType → builtin:tr-* asset id. */
export function transitionAssetId(type: TransitionType): string {
  return `builtin:tr-${type}`;
}

/** parse builtin:tr-* or bare TransitionType */
export function parseTransitionAssetId(assetId: string): TransitionType | null {
  const raw = assetId.replace(/^builtin:tr-/, '');
  if ((TRANSITION_ORDER as readonly string[]).includes(raw)) return raw as TransitionType;
  return null;
}

/** Zoom library id: library:zoom:<shape>. */
export function zoomLibraryId(shape: ZoomShape): string {
  return `library:zoom:${shape}`;
}

export function parseZoomLibraryId(assetId: string): ZoomShape | null {
  if (assetId === 'builtin:zoom') return 'hold'; // default shape when bare
  const m = /^library:zoom:(.+)$/.exec(assetId);
  if (!m) return null;
  const shape = m[1] as ZoomShape;
  return (ZOOM_SHAPE_ORDER as readonly string[]).includes(shape) ? shape : null;
}

const ZOOM_DESC: Record<ZoomShape, string> = {
  punch: 'Quick punch zoom — emphasis hit',
  instant: 'Snap to magnified frame — no animation',
  'slow-push': 'Gradual zoom across the entire clip',
  hold: 'Ease in, hold at peak, ease back out',
  'zoom-out': 'Start tight, pull back to 1×',
  'ease-in': 'Cubic ease-in push toward peak',
  bounce: 'Overshoot then settle (elastic)',
  snap: 'Very fast snap-in to peak magnification',
  pulse: 'Heartbeat pulse toward peak then ease back',
  'whip-in': 'Aggressive front-loaded whip into zoom',
};

export function buildLibraryItems(templates: Tpl[]): LibraryItem[] {
  const items: LibraryItem[] = [];

  for (const t of templates) {
    items.push({
      id: `library:motion-graphic:${t.id}`,
      name: t.name,
      category: 'motion-graphics',
      description: t.category,
      group: t.category,
      usage: `edit_item adds:[{type:"motion-graphic",assetId:"library:motion-graphic:${t.id}",track:"V1",startFrame?}]`,
    });
  }

  for (const id of LUT_IDS) {
    const d = LUT_EFFECTS[id];
    if (!d) continue;
    items.push({
      id: d.id,
      name: d.name,
      category: 'luts',
      description: d.desc,
      usage: `edit_item adds:[{type:"effect",targetItemId:"<clip>",assetId:"${d.id}",propertyOverrides:{intensity:1}}]`,
    });
  }

  for (const shape of ZOOM_SHAPE_ORDER) {
    items.push({
      id: zoomLibraryId(shape),
      name: ZOOM_SHAPE_LABELS[shape],
      category: 'zoom',
      description: ZOOM_DESC[shape] ?? shape,
      usage: `edit_item adds:[{type:"effect",targetItemId:"<clip>",assetId:"${zoomLibraryId(shape)}"}] — expands to builtin:zoom shape=${shape}`,
    });
  }

  for (const id of FX_IDS) {
    const d = FX_EFFECTS[id];
    if (!d) continue;
    items.push({
      id: d.id,
      name: d.name,
      category: 'fx',
      description: d.desc,
      usage: `edit_item adds:[{type:"effect",targetItemId:"<clip>",assetId:"${d.id}",propertyOverrides:{...}}]`,
    });
  }

  // Open-box AI Voice Isolation implemented with local ffmpeg.
  items.push({
    id: AUDIO_FX_ISOLATE_DEFAULT,
    name: 'Voice Isolation',
    category: 'audio-fx',
    description: 'Open-box speech denoise (ffmpeg spectral NR). Attaches denoisedSrc; master clip src unchanged.',
    group: 'voice',
    usage: 'isolate_voice itemId=<clip> action=apply strength?=70 — not edit_item (per-clip denoise, not a library place). action=clear removes. Library UI: 资源库 → 音频效果.',
  });
  items.push({
    id: AUDIO_FX_ISOLATE_LIGHT,
    name: 'Voice Isolation (Light)',
    category: 'audio-fx',
    description: 'Lighter denoise strength (strength≈35) for already-clean mics.',
    group: 'voice',
    usage: 'isolate_voice itemId=<clip> action=apply strength=35',
  });
  items.push({
    id: AUDIO_FX_ISOLATE_STRONG,
    name: 'Voice Isolation (Strong)',
    category: 'audio-fx',
    description: 'Aggressive denoise (strength≈90) for noisy rooms / street talk.',
    group: 'voice',
    usage: 'isolate_voice itemId=<clip> action=apply strength=90',
  });

  for (const s of SOUND_EFFECTS) {
    // Keep the group id (transition-emphasis, etc.) for browse_library filters.
    items.push({
      id: `library:sound:${s.id}`,
      name: s.name,
      category: 'sound-effects',
      description: s.desc,
      group: s.group,
      usage: `edit_item adds:[{type:"audio",assetId:"library:sound:${s.id}",fromFrame:<anchor>}]`,
    });
  }

  for (const type of TRANSITION_ORDER) {
    const id = transitionAssetId(type);
    items.push({
      id,
      name: TRANSITION_LABELS[type],
      category: 'transitions',
      description: `Video transition: ${type}`,
      group: 'transitions',
      usage: `edit_item adds:[{type:"transition",assetId:"${id}",incomingItemId:"<clip>"}] — places straddle cut into this clip; optional durationInFrames`,
    });
  }

  // 运行时注册的自定义/插件内容(submit_shader 产物 + 已装插件),agent 才看得见摸得着
  for (const d of Object.values(CUSTOM_FX)) {
    items.push({
      id: d.id,
      name: d.name,
      category: d.cube ? 'luts' : 'fx',
      description: d.desc,
      usage: `edit_item adds:[{type:"effect",targetItemId:"<clip>",assetId:"${d.id}",propertyOverrides:{...}}]`,
    });
  }
  for (const t of listCustomTransitions()) {
    items.push({
      id: t.id,
      name: t.label,
      category: 'transitions',
      description: 'Custom/plugin GLSL transition',
      group: 'transitions',
      usage: `edit_item adds:[{type:"transition",assetId:"${t.id}",incomingItemId:"<clip>"}]`,
    });
  }
  for (const z of listCustomZooms()) {
    items.push({
      id: z.id,
      name: z.label,
      category: 'zoom',
      description: '插件缩放曲线(envelope 包络)',
      usage: `edit_item adds:[{type:"effect",targetItemId:"<clip>",assetId:"${z.id}"}]`,
    });
  }

  return items;
}

export function libraryOverview(items: LibraryItem[]) {
  const groups = new Map<string, { id: string; name: string; count: number }>();
  for (const it of items) {
    const key = it.group ?? it.category;
    const cur = groups.get(key) ?? { id: key, name: key, count: 0 };
    cur.count++;
    groups.set(key, cur);
  }
  return {
    mode: 'overview' as const,
    total: items.length,
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
    usage: {
      category: 'Category returns a Library tab overview with group counts.',
      categoryGroup: 'Category + group returns list results from one group.',
      id: 'ID returns one item details + usage guidance for edit_item.',
      query: 'Query returns list results across (or within) categories.',
    },
  };
}
