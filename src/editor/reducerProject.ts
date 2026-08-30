import type { MediaAsset, ProjectDoc, Timeline, TimelineItem, TimelineState } from './types';
import { activeTimeline } from './types';
import { fitItemToDuration } from './clipFit';
import { reconcileTransitions } from './transitionReconcile';
import { sequenceGraphError, sequenceReferencesTo } from './sequenceGraph';
import { revisionAfterRelink, sourceRevisionOf, withMediaSourceRevision } from './mediaSourceRevision';
import { isTimelineMediaAssetKind } from './mediaTypes';
import { normalizeSha256Hash } from '../../shared/content-hash.js';
import { canonicalizeMediaAsset } from './mediaContentIdentity.js';
import { mapTimelineAssetItems, removeAssetFromTimeline, timelineItemUsesAsset } from './mediaAssetUsage';
import { introducesTrackOverlap } from './trackCollision';
import { newTranscriptGeneration } from '../transcript/identity';
import type { AnyAction, ProjectAction } from './reducerActions';
import { isRelinkableMediaKind, relinkTiming, type RelinkableTimelineItem } from './reducerTimelineHelpers';
import { reduce } from './reducerTimeline';

// ── project reducer (routes per-timeline actions to the active timeline) ───
export const maxOrder = (p: ProjectDoc) => p.timelines.reduce((m, t) => Math.max(m, t.order), -1);
const isProjectAction = (a: { type: string }): a is ProjectAction => a.type.startsWith('tl.') || a.type.startsWith('pool.') || a.type.startsWith('design.');

// stamp a per-timeline reducer result back onto its identity (setFullState
// returns a bare TimelineState, so id/name/order must be re-applied).
const stamp = (next: TimelineState, id: string, name: string, order: number): Timeline => {
  const { assets: _derivedAssets, ...persisted } = next;
  return { ...persisted, id, name, order };
};

export function projectReduce(p: ProjectDoc, a: AnyAction): ProjectDoc {
  if (a.type === 'batch') {
    return a.actions.reduce((doc, action) => projectReduce(doc, action), p);
  }
  if (a.type === 'addAsset') {
    if (p.assets.some((asset) => asset.id === a.asset.id)) return p;
    return { ...p, assets: [...p.assets, withMediaSourceRevision(a.asset)] };
  }
  if (isProjectAction(a)) {
    switch (a.type) {
      case 'tl.create': {
        const activeTimelineId = a.activate === false ? p.activeTimelineId : a.timeline.id;
        const next = { ...p, timelines: [...p.timelines, a.timeline], activeTimelineId };
        return sequenceGraphError(next) ? p : next;
      }
      case 'tl.switch':
        return p.activeTimelineId !== a.id && p.timelines.some((t) => t.id === a.id)
          ? { ...p, activeTimelineId: a.id }
          : p;
      case 'tl.duplicate': {
        const src = p.timelines.find((t) => t.id === a.id);
        if (!src) return p;
        // clone verbatim (item ids stay — timelines never share one items[] array,
        // so ids can't collide; retarget swaps the canvas for long→short).
        const copy: Timeline = {
          ...src, id: a.newId, name: a.name, order: maxOrder(p) + 1, selectedId: null, hidden: false,
          ...(a.retarget ? { width: a.retarget.width, height: a.retarget.height, fit: a.retarget.fit ?? src.fit ?? 'contain' } : {}),
        };
        const next = { ...p, timelines: [...p.timelines, copy], activeTimelineId: a.activate === false ? p.activeTimelineId : copy.id };
        return sequenceGraphError(next) ? p : next;
      }
      case 'tl.delete': {
        if (p.timelines.length <= 1 || sequenceReferencesTo(p, a.id).length > 0) return p;
        const rest = p.timelines.filter((t) => t.id !== a.id);
        if (rest.length === p.timelines.length) return p;
        const fallback = rest.find((t) => !t.hidden) ?? rest[0];
        const activeTimelineId = p.activeTimelineId === a.id ? fallback.id : p.activeTimelineId;
        return { ...p, timelines: rest, activeTimelineId };
      }
      case 'tl.rename':
        return { ...p, timelines: p.timelines.map((t) => (t.id === a.id ? { ...t, name: a.name } : t)) };
      case 'tl.retarget': {
        if (!Number.isFinite(a.width) || !Number.isFinite(a.height)) return p;
        const width = Math.round(a.width);
        const height = Math.round(a.height);
        if (width < 1 || height < 1) return p;
        return { ...p, timelines: p.timelines.map((t) => (t.id === a.id ? { ...t, width, height, fit: a.fit ?? t.fit ?? 'contain' } : t)) };
      }
      case 'tl.setHidden': {
        // The last visible timeline cannot be hidden.
        const visible = p.timelines.filter((t) => !t.hidden);
        if (a.hidden && visible.length <= 1 && visible[0]?.id === a.id) return p;
        const timelines = p.timelines.map((t) => (t.id === a.id ? { ...t, hidden: a.hidden } : t));
        // hiding the active timeline: the editor must show something → first visible
        const activeTimelineId =
          a.hidden && p.activeTimelineId === a.id
            ? (timelines.find((t) => !t.hidden)?.id ?? p.activeTimelineId)
            : p.activeTimelineId;
        return { ...p, timelines, activeTimelineId };
      }
      case 'tl.setDoc':
        return sequenceGraphError(a.doc) ? p : a.doc; // invalid sequence graphs never enter history
      case 'pool.createFolder':
        return p.mediaFolders.some((folder) => folder.parentId === a.folder.parentId && folder.name === a.folder.name)
          ? p
          : { ...p, mediaFolders: [...p.mediaFolders, a.folder] };
      case 'pool.renameFolder': {
        const folder = p.mediaFolders.find((item) => item.id === a.id);
        if (!folder || folder.name === a.name || p.mediaFolders.some((item) => item.id !== a.id && item.parentId === folder.parentId && item.name === a.name)) return p;
        return { ...p, mediaFolders: p.mediaFolders.map((item) => item.id === a.id ? { ...item, name: a.name } : item) };
      }
      case 'pool.deleteFolder':
        if (!p.mediaFolders.some((folder) => folder.id === a.id)) return p;
        if (p.assets.some((asset) => asset.folderId === a.id) || p.mediaFolders.some((folder) => folder.parentId === a.id)) return p;
        return { ...p, mediaFolders: p.mediaFolders.filter((folder) => folder.id !== a.id) };
      case 'pool.moveAssets': {
        if (a.folderId && !p.mediaFolders.some((folder) => folder.id === a.folderId)) return p;
        const ids = new Set(a.ids);
        if (!p.assets.some((asset) => ids.has(asset.id) && asset.folderId !== a.folderId)) return p;
        return { ...p, assets: p.assets.map((asset) => ids.has(asset.id) ? { ...asset, folderId: a.folderId } : asset) };
      }
      case 'pool.updateAsset': {
        const asset = p.assets.find((item) => item.id === a.id);
        if (!asset || Object.entries(a.patch).every(([key, value]) => asset[key as keyof MediaAsset] === value)) return p;
        const next = { ...asset, ...a.patch };
        const sourceChanged = 'code' in a.patch || 'props' in a.patch;
        const updated = sourceChanged
          ? { ...next, sourceRevision: revisionAfterRelink(asset, { ...next, sourceRevision: undefined }) }
          : next;
        const timelines = a.patch.name === undefined || a.patch.name === asset.name
          ? p.timelines
          : p.timelines.map((timeline) => mapTimelineAssetItems(
              timeline,
              asset,
              p.assets,
              (item) => ({ ...item, sourceAssetId: asset.id, name: a.patch.name! }),
            ));
        return {
          ...p,
          assets: p.assets.map((item) => item.id === a.id ? updated : item),
          timelines,
        };
      }
      case 'pool.setTranscription': {
        // Ingest ASR result → pool asset. Objects (words[]) always
        // differ by identity, so unlike updateAsset we don't early-out on equality.
        const asset = p.assets.find((item) => item.id === a.id);
        if (!asset) return p;
        const patch = 'transcript' in a.patch
          ? {
              ...a.patch,
              ...newTranscriptGeneration(a.patch.transcript ?? []),
              transcriptSourceRevision: a.patch.transcriptSourceRevision ?? sourceRevisionOf(asset),
              transcriptStale: false,
            }
          : a.patch;
        return { ...p, assets: p.assets.map((item) => item.id === a.id ? { ...item, ...patch } : item) };
      }
      case 'pool.relinkAsset': {
        // Relink File / Relink Missing Media updates the pool asset and every clip using its old src.
        const asset = p.assets.find((item) => item.id === a.id);
        if (!asset) return p;
        if (a.durationInFrames !== undefined
          && (!Number.isFinite(a.durationInFrames) || a.durationInFrames < 1)) return p;
        const replacement = {
          ...asset,
          src: a.src,
          name: a.name ?? asset.name,
          durationInFrames: a.durationInFrames ?? asset.durationInFrames,
          width: a.width ?? asset.width,
          height: a.height ?? asset.height,
          kind: a.kind ?? asset.kind,
          sourceRevision: a.sourceRevision,
          sourceContentHash: 'sourceContentHash' in a
            ? normalizeSha256Hash(a.sourceContentHash)
            : asset.sourceContentHash,
          sourceSize: a.sourceSize,
          sourceModifiedAt: a.sourceModifiedAt,
          sourceFilename: 'sourceFilename' in a ? a.sourceFilename : asset.sourceFilename,
          originalFilePath: 'originalFilePath' in a ? a.originalFilePath : asset.originalFilePath,
          // Exact clocks belong to the old source bytes and must be re-probed.
          sourceTimecode: undefined,
          captureClock: undefined,
        };
        const nextSourceRevision = revisionAfterRelink(asset, replacement);
        const sourceChanged = nextSourceRevision !== sourceRevisionOf(asset);
        const nextAsset: MediaAsset = {
          ...replacement,
          sourceRevision: nextSourceRevision,
          transcriptStale: sourceChanged && asset.transcript?.length ? true : asset.transcriptStale,
        };
        const usesRelinkedAsset = (item: TimelineItem): boolean => {
          if (item.kind === 'motion-graphic' && item.templateId === a.id) return false;
          return timelineItemUsesAsset(item, asset, p.assets);
        };
        const relinkTimelineItem = (item: TimelineItem): TimelineItem => {
          if (!isRelinkableMediaKind(item.kind)) return item;
          const replacementKind = a.kind && isTimelineMediaAssetKind(a.kind) ? a.kind : item.kind;
          const timing = relinkTiming(item, a.durationInFrames, replacementKind);
          if (!timing) return item;
          const {
            denoisedSrc: _staleDenoisedSrc,
            denoiseStrength: _staleDenoiseStrength,
            sourceTimecode: _staleSourceTimecode,
            captureClock: _staleCaptureClock,
            ...sourceIndependent
          } = item as RelinkableTimelineItem;
          return fitItemToDuration({
            ...sourceIndependent,
            ...timing,
            sourceAssetId: asset.id,
            src: a.src,
            sourceRevision: nextAsset.sourceRevision,
            sourceContentHash: nextAsset.sourceContentHash,
            sourceFilename: 'sourceFilename' in a ? a.sourceFilename : item.sourceFilename,
            originalFilePath: 'originalFilePath' in a ? a.originalFilePath : item.originalFilePath,
            name: a.name ?? item.name,
            width: a.width ?? item.width,
            height: a.height ?? item.height,
            kind: replacementKind,
            transcriptStale: sourceChanged && item.transcript?.length ? true : item.transcriptStale,
          });
        };
        const timelines = p.timelines.map((timeline) => {
          const relinked = mapTimelineAssetItems(
            timeline,
            asset,
            p.assets,
            (item) => usesRelinkedAsset(item) ? relinkTimelineItem(item) : item,
          );
          const itemsChanged = relinked.items.some((item, index) => item !== timeline.items[index]);
          if (!itemsChanged || !relinked.transitions?.length) return relinked;
          return {
            ...relinked,
            transitions: reconcileTransitions(relinked.items, relinked.transitions),
          };
        });
        if (timelines.some((timeline, index) => introducesTrackOverlap(p.timelines[index]!, timeline))) return p;
        return {
          ...p,
          assets: p.assets.map((item) => (item.id === a.id ? nextAsset : item)),
          timelines,
        };
      }
      case 'pool.canonicalizeAsset':
        return canonicalizeMediaAsset(p, a.duplicateId, a.canonicalId);
      case 'pool.removeAsset': {
        const asset = p.assets.find((item) => item.id === a.id);
        if (!asset) return p;
        return {
          ...p,
          assets: p.assets.filter((item) => item.id !== a.id),
          timelines: p.timelines.map((timeline) => removeAssetFromTimeline(timeline, asset, p.assets)),
        };
      }
      // Design style represents the project's brand.
      case 'design.set':
        return { ...p, designStyle: a.style ?? undefined };
      case 'design.patch':
        return { ...p, designStyle: { colors: [], fonts: [], ...p.designStyle, ...a.patch } };
      default:
        return p;
    }
  }
  // per-timeline action → apply to the active timeline only
  const active = activeTimeline(p);
  if (!active) return p;
  // Hang up the asset table (the stamp will be removed again): When cropping, you need to know how much source asset is left.
  const withAssets = { ...active, assets: p.assets };
  const next = reduce(withAssets, a);
  if (next === withAssets) return p;
  const stamped = stamp(next, active.id, active.name, active.order);
  const candidate = { ...p, timelines: p.timelines.map((t) => (t.id === active.id ? stamped : t)) };
  return sequenceGraphError(candidate) ? p : candidate;
}
