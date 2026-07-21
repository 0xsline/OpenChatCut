import type { AtomicAction } from '../editor/reduce';
import type { TimelineItem } from '../editor/types';
import type { SceneChange } from './detect';

export interface MappedScene extends SceneChange {
  timelineFrame: number;
  itemLocalFrame: number;
}

/** Map source-media cut times through clip trim and playback speed. */
export function mapScenesToItem(
  scenes: readonly SceneChange[],
  item: TimelineItem,
  fps: number,
): MappedScene[] {
  const sourceIn = item.srcInFrame ?? 0;
  const rate = Math.max(0.01, item.playbackRate ?? 1);
  const mapped = scenes.flatMap((scene): MappedScene[] => {
    const sourceFrame = (scene.timeMs / 1000) * fps;
    const itemLocalFrame = Math.round((sourceFrame - sourceIn) / rate);
    if (itemLocalFrame <= 0 || itemLocalFrame >= item.durationInFrames) return [];
    return [{ ...scene, itemLocalFrame, timelineFrame: item.startFrame + itemLocalFrame }];
  });
  const unique = new Map(mapped.map((scene) => [scene.timelineFrame, scene]));
  return [...unique.values()].sort((a, b) => a.timelineFrame - b.timelineFrame);
}

export function sceneMarkerActions(item: TimelineItem, scenes: readonly MappedScene[]): AtomicAction[] {
  return scenes.map((scene, index) => ({
    type: 'addMarker',
    marker: {
      id: `marker_${crypto.randomUUID()}`,
      scope: 'item',
      itemId: item.id,
      fromFrame: scene.timelineFrame,
      durationFrames: 0,
      note: `Scene ${index + 1} · ${scene.kind} · score ${scene.score.toFixed(3)}`,
      color: scene.kind === 'cut' ? 'yellow' : 'purple',
    },
  }));
}

export function sceneSplitActions(item: TimelineItem, scenes: readonly MappedScene[]): AtomicAction[] {
  let currentId = item.id;
  return scenes.map((scene) => {
    const nextId = `item_${crypto.randomUUID()}`;
    const action: AtomicAction = {
      type: 'split', id: currentId, atFrame: scene.timelineFrame, newId: nextId,
    };
    currentId = nextId;
    return action;
  });
}
