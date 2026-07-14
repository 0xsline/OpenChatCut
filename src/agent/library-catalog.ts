// ChatCut Library catalog for browse_library — mirrors source categories:
// motion-graphics | luts | zoom | fx | sound-effects | transitions
// (audio-fx reserved empty until we ship track audio FX).

import { SOUND_EFFECTS, SOUND_GROUPS } from '../audio/soundLibrary';
import {
  TRANSITION_LABELS,
  TRANSITION_ORDER,
  ZOOM_SHAPE_LABELS,
  ZOOM_SHAPE_ORDER,
  type TransitionType,
  type ZoomShape,
} from '../editor/types';
import { FX_EFFECTS, FX_IDS, LUT_EFFECTS, LUT_IDS } from '../gl/fx/effects';
import type { Tpl } from '../types';

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
  /** how to place via edit_item (source id-mode usage guidance) */
  usage?: string;
}

/** map TransitionType → source builtin:tr-* asset id */
export function transitionAssetId(type: TransitionType): string {
  return `builtin:tr-${type}`;
}

/** parse builtin:tr-* or bare TransitionType */
export function parseTransitionAssetId(assetId: string): TransitionType | null {
  const raw = assetId.replace(/^builtin:tr-/, '');
  if ((TRANSITION_ORDER as readonly string[]).includes(raw)) return raw as TransitionType;
  return null;
}

/** source library:zoom:<shape> */
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

  for (const s of SOUND_EFFECTS) {
    // keep source group id (transition-emphasis …) for browse_library filters
    items.push({
      id: `library:sound:${s.id}`,
      name: s.name,
      category: 'sound-effects',
      description: s.desc,
      group: s.group,
      usage: `edit_item adds:[{type:"audio",assetId:"library:sound:${s.id}",fromFrame:<anchor>}] (clone: add_audio with audioName)`,
    });
  }

  for (const type of TRANSITION_ORDER) {
    const id = transitionAssetId(type);
    items.push({
      id,
      name: TRANSITION_LABELS[type],
      category: 'transitions',
      description: `Video transition: ${type}`,
      usage: `edit_item adds:[{type:"transition",assetId:"${id}",incomingItemId:"<clip>"}] — places straddle cut into this clip; optional durationInFrames`,
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
