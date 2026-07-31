import type { AtomicAction } from './reduce';
import { getKeyframePropertyDefinition } from './keyframeRegistry';
import type { ClipTransform, KeyframeProp } from './types';

export interface KeyframeResetBatch {
  actions: AtomicAction[];
  label: string;
}

export function keyframeResetBatch(
  id: string,
  requestedProps: readonly KeyframeProp[],
): KeyframeResetBatch {
  const props = [...new Set(requestedProps)];
  const actions: AtomicAction[] = props.map((prop) => ({ type: 'clearKeyframes', id, prop }));
  const transform: ClipTransform = {};
  let resetVolume = false;

  for (const prop of props) {
    const definition = getKeyframePropertyDefinition(prop);
    if (definition.toTransformPatch) {
      Object.assign(transform, definition.toTransformPatch(definition.defaultValue));
    } else if (prop === 'volume') {
      resetVolume = true;
    }
  }

  if (Object.keys(transform).length) actions.push({ type: 'setTransform', id, patch: transform });
  if (resetVolume) actions.push({ type: 'setVolume', id, volume: 1 });
  return {
    actions,
    label: props.length === 1 ? `Reset ${props[0]}` : 'Reset transform',
  };
}
