export interface TimelineViewState {
  playhead: number;
  zoom: number;
  scrollLeft: number;
  trackScale: number;
}

export interface TimelineViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface TimelineViewStateEnvelope {
  version: 1;
  timelines: Record<string, TimelineViewState>;
}

export const DEFAULT_TIMELINE_VIEW_STATE: TimelineViewState = {
  playhead: 0,
  zoom: 1,
  scrollLeft: 0,
  trackScale: 1,
};

const storageKey = (projectId: string) => `cc.timelineViews.v1.${projectId}`;
const finiteAtLeast = (value: unknown, minimum: number, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback;

export function normalizeTimelineViewState(
  value: unknown,
  fallback: TimelineViewState = DEFAULT_TIMELINE_VIEW_STATE,
): TimelineViewState {
  const raw = value && typeof value === 'object' ? value as Partial<TimelineViewState> : {};
  return {
    playhead: Math.floor(finiteAtLeast(raw.playhead, 0, fallback.playhead)),
    zoom: finiteAtLeast(raw.zoom, 0.01, fallback.zoom),
    scrollLeft: finiteAtLeast(raw.scrollLeft, 0, fallback.scrollLeft),
    trackScale: finiteAtLeast(raw.trackScale, 0.01, fallback.trackScale),
  };
}

function readEnvelope(storage: TimelineViewStorage, projectId: string): TimelineViewStateEnvelope {
  try {
    const raw = storage.getItem(storageKey(projectId));
    if (!raw) return { version: 1, timelines: {} };
    const parsed = JSON.parse(raw) as Partial<TimelineViewStateEnvelope>;
    if (parsed.version !== 1 || !parsed.timelines || typeof parsed.timelines !== 'object') {
      return { version: 1, timelines: {} };
    }
    const timelines: Record<string, TimelineViewState> = {};
    for (const [timelineId, value] of Object.entries(parsed.timelines)) {
      timelines[timelineId] = normalizeTimelineViewState(value);
    }
    return { version: 1, timelines };
  } catch {
    return { version: 1, timelines: {} };
  }
}

export function loadTimelineViewState(
  storage: TimelineViewStorage,
  projectId: string,
  timelineId: string,
): TimelineViewState | null {
  const envelope = readEnvelope(storage, projectId);
  return Object.hasOwn(envelope.timelines, timelineId) ? envelope.timelines[timelineId]! : null;
}

export function saveTimelineViewState(
  storage: TimelineViewStorage,
  projectId: string,
  timelineId: string,
  patch: Partial<TimelineViewState>,
): TimelineViewState {
  const envelope = readEnvelope(storage, projectId);
  const current = envelope.timelines[timelineId] ?? DEFAULT_TIMELINE_VIEW_STATE;
  const next = normalizeTimelineViewState({ ...current, ...patch }, current);
  envelope.timelines[timelineId] = next;
  try {
    storage.setItem(storageKey(projectId), JSON.stringify(envelope));
  } catch {
    // Browser privacy/quota errors only reset editor chrome; project data is unaffected.
  }
  return next;
}

export function clearTimelineViewStates(storage: TimelineViewStorage, projectId: string): void {
  try {
    storage.removeItem(storageKey(projectId));
  } catch {
    // Ignore unavailable browser storage.
  }
}
