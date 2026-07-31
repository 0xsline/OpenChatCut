import type { MediaAsset, ProjectDoc, Timeline, TimelineItem } from './types.js';

export const DEFAULT_SEQUENCE_GRAPH_LIMITS = {
  maxDepth: 16,
  maxNodes: 2048,
} as const;

export interface SequenceGraphLimits {
  maxDepth?: number;
  maxNodes?: number;
}

export type SequenceGraphErrorCode =
  | 'SEQUENCE_TIMELINE_MISSING'
  | 'SEQUENCE_FPS_MISMATCH'
  | 'SEQUENCE_CYCLE'
  | 'SEQUENCE_DEPTH_LIMIT'
  | 'SEQUENCE_NODE_LIMIT'
  | 'SEQUENCE_DUPLICATE_TIMELINE_ID';

export interface SequenceGraphErrorDetails {
  code: SequenceGraphErrorCode;
  message: string;
  timelineId?: string;
  itemId?: string;
  referencedTimelineId?: string;
  parentFps?: number;
  childFps?: number;
  path: string[];
  limit?: number;
}

export class SequenceGraphError extends Error {
  readonly code: SequenceGraphErrorCode;
  readonly timelineId?: string;
  readonly itemId?: string;
  readonly referencedTimelineId?: string;
  readonly parentFps?: number;
  readonly childFps?: number;
  readonly path: string[];
  readonly limit?: number;

  constructor(details: Omit<SequenceGraphErrorDetails, 'message'> & { message?: string }) {
    const message = details.message ?? sequenceErrorMessage(details);
    super(message);
    this.name = 'SequenceGraphError';
    this.code = details.code;
    this.timelineId = details.timelineId;
    this.itemId = details.itemId;
    this.referencedTimelineId = details.referencedTimelineId;
    this.parentFps = details.parentFps;
    this.childFps = details.childFps;
    this.path = details.path;
    this.limit = details.limit;
  }

  toJSON(): SequenceGraphErrorDetails {
    return {
      code: this.code,
      message: this.message,
      timelineId: this.timelineId,
      itemId: this.itemId,
      referencedTimelineId: this.referencedTimelineId,
      parentFps: this.parentFps,
      childFps: this.childFps,
      path: this.path,
      limit: this.limit,
    };
  }
}

function sequenceErrorMessage(details: Omit<SequenceGraphErrorDetails, 'message'>): string {
  switch (details.code) {
    case 'SEQUENCE_TIMELINE_MISSING':
      return `Sequence item ${details.itemId ?? '(unknown)'} references missing timeline ${details.referencedTimelineId ?? '(unknown)'}`;
    case 'SEQUENCE_FPS_MISMATCH':
      return `Sequence FPS mismatch: parent timeline ${details.timelineId ?? '(unknown)'} is ${details.parentFps ?? '(unknown)'}fps, child timeline ${details.referencedTimelineId ?? '(unknown)'} is ${details.childFps ?? '(unknown)'}fps`;
    case 'SEQUENCE_CYCLE':
      return `Sequence cycle detected: ${details.path.join(' -> ')}`;
    case 'SEQUENCE_DEPTH_LIMIT':
      return `Sequence nesting exceeds maximum depth ${details.limit}`;
    case 'SEQUENCE_NODE_LIMIT':
      return `Sequence render graph exceeds maximum node count ${details.limit}`;
    case 'SEQUENCE_DUPLICATE_TIMELINE_ID':
      return `Duplicate timeline id ${details.timelineId ?? '(unknown)'}`;
  }
}

export function isSequenceGraphError(error: unknown): error is SequenceGraphError {
  return error instanceof SequenceGraphError;
}

export type SequenceItem = TimelineItem & { kind: 'sequence'; timelineId: string };

export function isSequenceItem(item: TimelineItem): item is SequenceItem {
  return item.kind === 'sequence' && typeof item.timelineId === 'string' && item.timelineId.length > 0;
}

/** Place a nested Remotion Sequence so its frame equals the mapped source frame. */
export function nestedSequenceFrom(parentFrame: number, sourceFrame: number): number {
  return parentFrame - sourceFrame;
}

function limitsOf(limits: SequenceGraphLimits): Required<SequenceGraphLimits> {
  return {
    maxDepth: Math.max(1, Math.floor(limits.maxDepth ?? DEFAULT_SEQUENCE_GRAPH_LIMITS.maxDepth)),
    maxNodes: Math.max(1, Math.floor(limits.maxNodes ?? DEFAULT_SEQUENCE_GRAPH_LIMITS.maxNodes)),
  };
}

function timelineFpsMatches(parentFps: number, childFps: number): boolean {
  if (!Number.isFinite(parentFps) || !Number.isFinite(childFps)) return false;
  if (parentFps === childFps) return true;
  const scale = Math.max(Math.abs(parentFps), Math.abs(childFps));
  return Math.abs(parentFps - childFps) <= Number.EPSILON * scale;
}

interface SequenceTraversal {
  readonly limits: Required<SequenceGraphLimits>;
  readonly activePath: Set<string>;
  nodeCount: number;
}

interface SequenceTraversalEdge {
  owner: Timeline;
  item: TimelineItem;
}

function createSequenceTraversal(limits: Required<SequenceGraphLimits>): SequenceTraversal {
  return {
    limits,
    activePath: new Set(),
    nodeCount: 0,
  };
}

function enterSequenceNode(
  traversal: SequenceTraversal,
  timeline: Timeline,
  path: string[],
  edge?: SequenceTraversalEdge,
): void {
  if (traversal.activePath.has(timeline.id)) {
    const first = path.indexOf(timeline.id);
    throw new SequenceGraphError({
      code: 'SEQUENCE_CYCLE',
      timelineId: edge?.owner.id ?? timeline.id,
      itemId: edge?.item.id,
      referencedTimelineId: timeline.id,
      path: first >= 0 ? path.slice(first) : path,
    });
  }
  if (path.length > traversal.limits.maxDepth) {
    throw new SequenceGraphError({
      code: 'SEQUENCE_DEPTH_LIMIT',
      timelineId: timeline.id,
      path,
      limit: traversal.limits.maxDepth,
    });
  }
  traversal.nodeCount += 1;
  if (traversal.nodeCount > traversal.limits.maxNodes) {
    throw new SequenceGraphError({
      code: 'SEQUENCE_NODE_LIMIT',
      timelineId: timeline.id,
      path,
      limit: traversal.limits.maxNodes,
    });
  }
  traversal.activePath.add(timeline.id);
}

function leaveSequenceNode(traversal: SequenceTraversal, timeline: Timeline): void {
  traversal.activePath.delete(timeline.id);
}


function timelineIndex(doc: Pick<ProjectDoc, 'timelines'>): Map<string, Timeline> {
  const timelines = new Map<string, Timeline>();
  for (const timeline of doc.timelines) {
    if (timelines.has(timeline.id)) {
      throw new SequenceGraphError({
        code: 'SEQUENCE_DUPLICATE_TIMELINE_ID',
        timelineId: timeline.id,
        path: [timeline.id],
      });
    }
    timelines.set(timeline.id, timeline);
  }
  return timelines;
}

function referencedTimeline(
  timelines: ReadonlyMap<string, Timeline>,
  owner: Timeline,
  item: TimelineItem,
  path: string[],
): Timeline {
  const targetId = item.timelineId;
  const target = typeof targetId === 'string' ? timelines.get(targetId) : undefined;
  if (!target) {
    throw new SequenceGraphError({
      code: 'SEQUENCE_TIMELINE_MISSING',
      timelineId: owner.id,
      itemId: item.id,
      referencedTimelineId: typeof targetId === 'string' ? targetId : undefined,
      path,
    });
  }
  if (!timelineFpsMatches(owner.fps, target.fps)) {
    throw new SequenceGraphError({
      code: 'SEQUENCE_FPS_MISMATCH',
      timelineId: owner.id,
      itemId: item.id,
      referencedTimelineId: target.id,
      parentFps: owner.fps,
      childFps: target.fps,
      path,
    });
  }
  return target;
}

/** Validate every sequence reference in a document before it can be committed or rendered. */
export function validateSequenceGraph(doc: Pick<ProjectDoc, 'timelines'>, limits: SequenceGraphLimits = {}): void {
  const resolvedLimits = limitsOf(limits);
  const timelines = timelineIndex(doc);

  const visit = (
    timeline: Timeline,
    path: string[],
    traversal: SequenceTraversal,
    edge?: SequenceTraversalEdge,
  ): void => {
    enterSequenceNode(traversal, timeline, path, edge);
    for (const item of timeline.items) {
      if (item.kind !== 'sequence') continue;
      const target = referencedTimeline(timelines, timeline, item, [...path, String(item.timelineId ?? '')]);
      visit(target, [...path, target.id], traversal, { owner: timeline, item });
    }
    leaveSequenceNode(traversal, timeline);
  };

  for (const timeline of doc.timelines) {
    visit(timeline, [timeline.id], createSequenceTraversal(resolvedLimits));
  }
}

export function sequenceGraphError(
  doc: Pick<ProjectDoc, 'timelines'>,
  limits: SequenceGraphLimits = {},
): SequenceGraphError | null {
  try {
    validateSequenceGraph(doc, limits);
    return null;
  } catch (error) {
    if (isSequenceGraphError(error)) return error;
    throw error;
  }
}

export interface SequenceReference {
  timelineId: string;
  itemId: string;
}

/** Return the references that make deleting a timeline unsafe. */
export function sequenceReferencesTo(
  doc: Pick<ProjectDoc, 'timelines'>,
  timelineId: string,
): SequenceReference[] {
  return doc.timelines.flatMap((timeline) => timeline.items
    .filter((item) => item.kind === 'sequence' && item.timelineId === timelineId)
    .map((item) => ({ timelineId: timeline.id, itemId: item.id })));
}

/** Validate one prospective edge without mutating the document. */
export function sequenceReferenceError(
  doc: Pick<ProjectDoc, 'timelines'>,
  ownerTimelineId: string,
  referencedTimelineId: string,
  limits: SequenceGraphLimits = {},
): SequenceGraphError | null {
  const owner = doc.timelines.find((timeline) => timeline.id === ownerTimelineId);
  if (!owner) {
    return new SequenceGraphError({
      code: 'SEQUENCE_TIMELINE_MISSING',
      timelineId: ownerTimelineId,
      path: [ownerTimelineId],
    });
  }
  const target = doc.timelines.find((timeline) => timeline.id === referencedTimelineId);
  if (!target) {
    return new SequenceGraphError({
      code: 'SEQUENCE_TIMELINE_MISSING',
      timelineId: ownerTimelineId,
      referencedTimelineId,
      path: [ownerTimelineId, referencedTimelineId],
    });
  }
  const probe: Timeline = {
    ...owner,
    items: [...owner.items, {
      id: '__sequence_reference_probe__',
      track: owner.trackOrder?.[0] ?? 'V1',
      startFrame: 0,
      durationInFrames: 1,
      name: target.name,
      kind: 'sequence',
      timelineId: referencedTimelineId,
    }],
  };
  return sequenceGraphError({ timelines: doc.timelines.map((timeline) => timeline.id === ownerTimelineId ? probe : timeline) }, limits);
}

export interface TimelineRenderPlan {
  timelineId: string;
  durationInFrames: number;
  timelineIds: string[];
  nodeCount: number;
  assets: MediaAsset[];
  assetIds: string[];
  sources: string[];
}

/**
 * Resolve the expanded render tree, effective duration, and media dependencies.
 * Repeated sequence instances count as separate render nodes but dependencies are deduplicated.
 */
export function resolveTimelineRenderPlan(
  doc: Pick<ProjectDoc, 'timelines' | 'assets'>,
  timelineId: string,
  limits: SequenceGraphLimits = {},
): TimelineRenderPlan {
  const resolvedLimits = limitsOf(limits);
  const timelines = timelineIndex(doc);
  const root = timelines.get(timelineId);
  if (!root) {
    throw new SequenceGraphError({
      code: 'SEQUENCE_TIMELINE_MISSING',
      referencedTimelineId: timelineId,
      path: [timelineId],
    });
  }

  const timelineIds = new Set<string>();
  const assetIds = new Set<string>();
  const sources = new Set<string>();
  const assetsById = new Map(doc.assets.map((asset) => [asset.id, asset]));
  const assetsBySource = new Map(doc.assets.map((asset) => [asset.src, asset]));
  const traversal = createSequenceTraversal(resolvedLimits);

  const collectItemAsset = (item: TimelineItem): void => {
    if (item.src) {
      sources.add(item.src);
      const asset = assetsBySource.get(item.src);
      if (asset) assetIds.add(asset.id);
    }
    if (item.templateId && assetsById.has(item.templateId)) assetIds.add(item.templateId);
  };

  const visit = (
    timeline: Timeline,
    path: string[],
    edge?: SequenceTraversalEdge,
  ): number => {
    enterSequenceNode(traversal, timeline, path, edge);
    timelineIds.add(timeline.id);
    let duration = Math.max(1, timeline.fps);
    for (const item of timeline.items) {
      if (item.kind !== 'sequence') {
        collectItemAsset(item);
        duration = Math.max(duration, item.startFrame + item.durationInFrames);
        continue;
      }
      const target = referencedTimeline(timelines, timeline, item, [...path, String(item.timelineId ?? '')]);
      visit(target, [...path, target.id], { owner: timeline, item });
      duration = Math.max(duration, item.startFrame + item.durationInFrames);
    }
    leaveSequenceNode(traversal, timeline);
    return duration;
  };

  const durationInFrames = visit(root, [root.id]);
  const assets = [...assetIds].map((id) => assetsById.get(id)).filter((asset): asset is MediaAsset => !!asset);
  return {
    timelineId,
    durationInFrames,
    timelineIds: [...timelineIds],
    nodeCount: traversal.nodeCount,
    assets,
    assetIds: [...assetIds],
    sources: [...sources],
  };
}

export function sequenceItemDuration(
  doc: Pick<ProjectDoc, 'timelines' | 'assets'>,
  item: TimelineItem,
  limits: SequenceGraphLimits = {},
): number {
  if (item.kind !== 'sequence' || !item.timelineId) return item.durationInFrames;
  resolveTimelineRenderPlan(doc, item.timelineId, limits);
  return item.durationInFrames;
}
