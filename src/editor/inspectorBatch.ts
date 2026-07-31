import type { Action } from './reduce';
import type { TimelineItem, TimelineState } from './types';

export type InspectorMixedValue<T> =
  | { mixed: false; value: T }
  | { mixed: true; value: undefined };

export interface InspectorBatchPlan {
  ok: boolean;
  actions: Action[];
  reason?: 'empty-selection' | 'missing-item' | 'duplicate-selection' | 'locked-track' | 'unsupported' | 'planning-failed';
}

function equalInspectorValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => equalInspectorValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => Object.hasOwn(rightRecord, key)
      && equalInspectorValue(leftRecord[key], rightRecord[key]));
}

export function inspectorMixedValue<T>(
  items: readonly TimelineItem[],
  read: (item: TimelineItem) => T,
): InspectorMixedValue<T> {
  if (!items.length) return { mixed: true, value: undefined };
  const value = read(items[0]!);
  for (let index = 1; index < items.length; index += 1) {
    if (!equalInspectorValue(read(items[index]!), value)) return { mixed: true, value: undefined };
  }
  return { mixed: false, value };
}

export function selectedInspectorItems(state: TimelineState, selectedIds: readonly string[]): TimelineItem[] {
  const selected: TimelineItem[] = [];
  if (!selectedIds.length) return selected;
  const byId = new Map(state.items.map((item) => [item.id, item]));
  for (const id of selectedIds) {
    const item = byId.get(id);
    if (item) selected.push(item);
  }
  return selected;
}

/**
 * Preflight the complete selection before releasing any reducer actions.
 * Callers dispatch the returned actions as one `commands.batch`; a missing,
 * locked, unsupported, or failed target therefore publishes nothing.
 */
export function planInspectorBatch(
  state: TimelineState,
  selectedIds: readonly string[],
  makeActions: (item: TimelineItem) => Action | readonly Action[] | null,
  supports: (item: TimelineItem) => boolean = () => true,
): InspectorBatchPlan {
  if (!selectedIds.length) return { ok: false, actions: [], reason: 'empty-selection' };
  if (new Set(selectedIds).size !== selectedIds.length) {
    return { ok: false, actions: [], reason: 'duplicate-selection' };
  }
  const byId = new Map(state.items.map((item) => [item.id, item]));
  const items: TimelineItem[] = [];
  for (const id of selectedIds) {
    const item = byId.get(id);
    if (!item) return { ok: false, actions: [], reason: 'missing-item' };
    if (state.tracks?.[item.track]?.locked) return { ok: false, actions: [], reason: 'locked-track' };
    if (!supports(item)) return { ok: false, actions: [], reason: 'unsupported' };
    items.push(item);
  }

  const actions: Action[] = [];
  try {
    for (const item of items) {
      const planned = makeActions(item);
      if (!planned) return { ok: false, actions: [], reason: 'planning-failed' };
      if (Array.isArray(planned)) actions.push(...planned);
      else actions.push(planned as Action);
    }
  } catch {
    return { ok: false, actions: [], reason: 'planning-failed' };
  }
  return actions.length
    ? { ok: true, actions }
    : { ok: false, actions: [], reason: 'planning-failed' };
}
