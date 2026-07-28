import { applyLibraryToClip, applyLibraryToTrack } from '../components/timeline/libraryDropActions';
import { makeDraft } from '../editor/store';
import type { MediaAsset, TimelineState } from '../editor/types';
import type { LibraryDragPayload } from '../library/drag';
import { pluginResourceItems, pluginTemplates } from '../library/pluginResources';
import { docFromTimeline } from '../persist/projectStore';
import {
  HOVER_DURATION_MS,
  HOVER_HOLD_FRACTION,
} from '../gl/transitionThumb';
import {
  registerPack,
  unregisterPack,
  type InstalledPack,
} from './store';
import type { PluginPack } from './types';

export type ResourcePreviewCategory = 'mg' | 'transition' | 'fx' | 'zoom' | 'lut';

const FPS = 30;
const FRAMES = FPS * 5;
const TRACK = 'preview-video';
const TRANSITION_PREVIEW_FRAMES = Math.round(FPS * HOVER_DURATION_MS / 1000);
const TRANSITION_EFFECT_FRAMES = Math.round(
  TRANSITION_PREVIEW_FRAMES * (1 - 2 * HOVER_HOLD_FRACTION),
);

function emptyTimeline(): TimelineState {
  return {
    fps: FPS,
    width: 1920,
    height: 1080,
    fit: 'cover',
    items: [],
    selectedId: null,
    trackOrder: [TRACK],
    tracks: { [TRACK]: { kind: 'video' } },
  };
}

function asInstalledPack(pack: PluginPack): InstalledPack {
  return {
    ...pack,
    enabled: true,
    installedAt: 0,
    cubeUrls: Object.fromEntries(
      pack.items
        .flatMap((item) => item.type === 'lut' && item.cube
          ? [[item.id, `data:text/plain;charset=utf-8,${encodeURIComponent(item.cube)}`]]
          : []),
    ),
  };
}

function coverAsset(
  id: string,
  src: string,
  durationInFrames: number,
): MediaAsset {
  return {
    id,
    name: 'Preview source',
    kind: 'image',
    src,
    durationInFrames,
    width: 1920,
    height: 1080,
  };
}

function resourcePayload(
  pack: InstalledPack,
  category: Exclude<ResourcePreviewCategory, 'mg'>,
): LibraryDragPayload {
  const resource = pluginResourceItems([pack], category)[0];
  if (!resource) throw new Error(`package has no ${category} item`);
  return {
    v: 1,
    kind: category,
    id: resource.id,
    name: resource.name,
    ...(resource.data === undefined ? {} : { data: resource.data }),
  };
}

function buildMg(pack: InstalledPack): TimelineState {
  const draft = makeDraft(docFromTimeline(emptyTimeline()));
  const template = pluginTemplates([pack])[0];
  if (!template) throw new Error('package has no mg-template item');
  const applied = applyLibraryToTrack(
    { state: draft.getState(), commands: draft.commands, notice: () => undefined },
    { v: 1, kind: 'template', id: template.id, name: template.name, data: template },
    TRACK,
    0,
    false,
  );
  if (!applied) throw new Error('MG template was rejected by OpenChatCut');
  return draft.getState();
}

function addVisualClips(
  draft: ReturnType<typeof makeDraft>,
  category: Exclude<ResourcePreviewCategory, 'mg'>,
  coverDataUrl: string,
  targetDataUrl?: string,
): string {
  const outgoingFrames = category === 'transition'
    ? Math.ceil(TRANSITION_PREVIEW_FRAMES / 2)
    : FRAMES;
  const asset = coverAsset('preview-cover', coverDataUrl, outgoingFrames);
  draft.commands.addAsset(asset);
  const firstId = draft.commands.addMediaItem(asset, { track: TRACK, startFrame: 0 });
  if (category !== 'transition') return firstId;
  const target = coverAsset(
    'preview-target',
    targetDataUrl || coverDataUrl,
    TRANSITION_PREVIEW_FRAMES - outgoingFrames,
  );
  draft.commands.addAsset(target);
  const incomingId = draft.commands.addMediaItem(target, {
    track: TRACK,
    startFrame: outgoingFrames,
  });
  if (!targetDataUrl) {
    draft.commands.setItemTransform(incomingId, { scale: 1.08 });
    draft.commands.setItemFilters(incomingId, { brightness: 0.92, saturate: 0.82 });
  }
  return incomingId;
}

function buildVisual(
  pack: InstalledPack,
  category: Exclude<ResourcePreviewCategory, 'mg'>,
  coverDataUrl: string,
  targetDataUrl?: string,
): TimelineState {
  const draft = makeDraft(docFromTimeline(emptyTimeline()));
  const itemId = addVisualClips(draft, category, coverDataUrl, targetDataUrl);
  const state = draft.getState();
  const item = state.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error('preview clip was not created');
  let notice = '';
  const applied = applyLibraryToClip(
    { state, commands: draft.commands, notice: (message) => { notice = message; } },
    resourcePayload(pack, category),
    item,
  );
  if (!applied) throw new Error(notice || `${category} was rejected by OpenChatCut`);
  if (category === 'transition') {
    const transition = draft.getState().transitions?.find(
      (candidate) => candidate.incomingItemId === itemId,
    );
    if (!transition) throw new Error('transition preview was not created');
    draft.commands.setTransition(transition.id, {
      durationInFrames: TRANSITION_EFFECT_FRAMES,
    });
  }
  return draft.getState();
}

export async function buildResourcePreviewState(
  sourcePack: PluginPack,
  category: ResourcePreviewCategory,
  coverDataUrl: string,
  targetDataUrl?: string,
): Promise<TimelineState> {
  const pack = asInstalledPack(sourcePack);
  await registerPack(pack);
  try {
    return category === 'mg'
      ? buildMg(pack)
      : buildVisual(pack, category, coverDataUrl, targetDataUrl);
  } finally {
    await unregisterPack(pack);
  }
}
