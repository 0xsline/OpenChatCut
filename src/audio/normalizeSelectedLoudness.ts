import { planInspectorBatch } from '../editor/inspectorBatch';
import { captureTimelineItemSource, validateTimelineItemSourceBatch } from '../editor/mediaSourceRevision';
import type { EditorCommands } from '../editor/store';
import type { ProjectDoc, TimelineItem, TimelineState } from '../editor/types';
import { analyzeLoudnessBatch, gainForTarget } from './loudness';

/** Publish one undoable batch only after every original source is still current. */
export async function normalizeSelectedLoudness(
  items: readonly TimelineItem[],
  getState: () => TimelineState,
  getDoc: () => ProjectDoc,
  commands: Pick<EditorCommands, 'batch'>,
): Promise<void> {
  if (!items.length || items.some((item) => item.kind !== 'audio' || !item.src)) return;
  const doc = getDoc();
  const snapshots = items.map((item) => captureTimelineItemSource(item, doc.assets));
  const analyses = await analyzeLoudnessBatch(snapshots.map((snapshot) => snapshot.src));
  const results = new Map(snapshots.map((snapshot) => {
    const analysis = analyses.get(snapshot.src)!;
    if (analysis.status === 'rejected') throw analysis.reason;
    return [snapshot.itemId, { sourceRevision: snapshot.sourceRevision, gain: gainForTarget(analysis.value, -14) }];
  }));
  const live = getState();
  if (getDoc().activeTimelineId !== doc.activeTimelineId
    || validateTimelineItemSourceBatch(snapshots, live.items, getDoc().assets, results).status === 'stale') {
    throw new Error('Audio source changed during loudness analysis');
  }
  const plan = planInspectorBatch(live, snapshots.map((snapshot) => snapshot.itemId),
    (item) => ({ type: 'setVolume', id: item.id, volume: results.get(item.id)!.gain }),
    (item) => item.kind === 'audio' && results.has(item.id));
  if (plan.ok) commands.batch(plan.actions, 'Normalize selected loudness');
}
