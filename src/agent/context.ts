import type { EditorCommands } from '../editor/store';
import type { ProjectDoc, TimelineItem, TimelineState } from '../editor/types';
import { trackAlias } from '../editor/types';
import type { Tpl } from '../types';
import type { AudioAsset } from '../audio/library';
import {
  SELECTION_REF_CATEGORY, isSelectionRefKind, timelineIdOf,
  type AssetRefKind, type SelectionReference,
} from './selection-refs';

/** A media-pool asset or template mention (the pre-existing @ Quote). */
export interface AssetReference {
  id: string;
  name: string;
  kind: AssetRefKind;
  metadata?: undefined;
}

/** Everything the composer can attach to a message: pool assets/templates plus
 * the five selection-mode reference types (item / timepoint / timerange
 * / canvas-region / transcript-selection). Discriminated on `kind`. */
export type AgentReference = AssetReference | SelectionReference;

export function isSelectionReference(ref: AgentReference): ref is SelectionReference {
  return isSelectionRefKind(ref.kind);
}

/** What the agent's tools operate on: the live editor. */
export interface AgentContext {
  commands: EditorCommands;
  /** the ACTIVE timeline (per-clip tools read this) */
  getState: () => TimelineState;
  /** the whole project — all timelines + which is active (manage_timelines reads this) */
  getDoc: () => ProjectDoc;
  /** the active creative-mode skill id, or null; drives prompt injection */
  getCreativeMode: () => string | null;
  /** switch / clear the active creative mode (manage_skill activate; chat-level, not undoable) */
  setCreativeMode?: (id: string | null) => void;
  templates: Tpl[];
  audio: AudioAsset[];
  /** Open project id (hash route /#/editor/:id). Used by project tools. */
  getProjectId?: () => string;
  /** Navigate editor to another project (flush + hash change). */
  openProject?: (projectId: string) => Promise<{ ok: boolean; error?: string } | void>;
  /** Dashboard/title rename when edit_project updates the open project. */
  onProjectRenamed?: (name: string) => void;
}

/** Source-media span of a placed clip in ms (srcIn → srcIn + duration·rate). */
function sourceMediaSpan(item: TimelineItem, fps: number): Record<string, number> {
  if (item.kind !== 'video' && item.kind !== 'audio' && item.kind !== 'gif') return {};
  const startMs = ((item.srcInFrame ?? 0) / fps) * 1000;
  const endMs = startMs + ((item.durationInFrames * (item.playbackRate ?? 1)) / fps) * 1000;
  return { sourceMediaStartMs: Math.round(startMs), sourceMediaEndMs: Math.round(endMs) };
}

/** A selection-mode reference → one structured `user_reference` entry. Item
 * refs re-resolve against the LIVE state at send time;
 * transcript refs pick up the pool assetId; a timeline mismatch is surfaced as
 * a warning instead of silently retargeting. */
function resolveSelectionReference(ctx: AgentContext, ref: SelectionReference): Record<string, unknown> {
  const state = ctx.getState();
  const entry: Record<string, unknown> = {
    type: 'user_reference',
    referenceType: ref.kind,
    category: SELECTION_REF_CATEGORY[ref.kind],
    displayName: ref.name,
  };
  let metadata: Record<string, unknown> = { ...ref.metadata };
  if (ref.kind === 'item') {
    const item = state.items.find((it) => it.id === ref.metadata.itemId);
    if (item) {
      metadata = {
        ...metadata,
        itemName: item.name,
        itemKind: item.kind,
        trackId: item.track,
        trackAlias: trackAlias(state, item.track),
        timelineFrameStart: item.startFrame,
        timelineFrameEnd: item.startFrame + item.durationInFrames,
        ...sourceMediaSpan(item, state.fps),
      };
    } else {
      entry.warning = 'referenced item no longer exists on the timeline; metadata is the pick-time snapshot';
    }
  } else if (ref.kind === 'transcript-selection') {
    const item = state.items.find((it) => it.id === ref.metadata.itemId);
    const asset = item?.src ? ctx.getDoc().assets.find((a) => a.src === item.src) : undefined;
    if (asset) metadata = { ...metadata, assetId: asset.id };
  } else if (ref.kind === 'canvas-region') {
    metadata = {
      ...metadata,
      containedItemNames: ref.metadata.containedItems.map(
        (id) => state.items.find((it) => it.id === id)?.name ?? id,
      ),
    };
  }
  const pickedTimelineId = (ref.metadata as { timelineId?: string }).timelineId;
  const activeTimelineId = timelineIdOf(state);
  if (pickedTimelineId && activeTimelineId && pickedTimelineId !== activeTimelineId && !entry.warning) {
    entry.warning = `reference was created on timeline ${pickedTimelineId}, but ${activeTimelineId} is active at submit time; using the original reference metadata`;
  }
  entry.metadata = metadata;
  return entry;
}

/** Resolve UI mentions by stable id; names in the prompt are display-only. */
export function resolveAgentReferences(ctx: AgentContext, references: AgentReference[]): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    if (seen.has(reference.id)) continue;
    seen.add(reference.id);
    if (isSelectionReference(reference)) {
      entries.push(resolveSelectionReference(ctx, reference));
    } else if (reference.kind === 'template') {
      const template = ctx.templates.find((item) => item.id === reference.id);
      if (template) entries.push({ type: 'template', id: template.id, name: template.name, category: template.category, width: template.width, height: template.height, durationInFrames: template.durationInFrames, propKeys: template.propSchema.map((prop) => prop.key) });
    } else {
      const asset = ctx.getDoc().assets.find((item) => item.id === reference.id);
      if (asset) entries.push({ type: 'asset', id: asset.id, name: asset.name, kind: asset.kind, src: asset.src, durationInFrames: asset.durationInFrames, width: asset.width, height: asset.height });
    }
  }
  return entries;
}
