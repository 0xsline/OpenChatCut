import {
  clearTimelineViewStates,
  loadTimelineViewState,
  saveTimelineViewState,
  type TimelineViewState,
  type TimelineViewStorage,
} from '../editor/timelineViewState';

// Lightweight per-project UI continuity (localStorage). Not part of ProjectDoc /
// undo — lost keys only reset chrome, never the timeline.

export type ChatModePref = 'agent' | 'ask';

const draftKey = (projectId: string) => `cc.composerDraft.${projectId}`;
const modeKey = (projectId: string) => `cc.chatMode.${projectId}`;
const autoApplyKey = (projectId: string) => `cc.chatAutoApply.${projectId}`;
const playheadKey = (projectId: string) => `cc.playhead.${projectId}`;
const RECENT_TEMPLATES_KEY = 'cc.recentTemplates';
const MAX_RECENT = 16;

function readRaw(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* private mode / quota */
  }
}

function removeRaw(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

// ── composer draft ──────────────────────────────────────────────────────────

export function loadComposerDraft(projectId: string): string {
  return readRaw(draftKey(projectId)) ?? '';
}

export function saveComposerDraft(projectId: string, text: string): void {
  const t = text.trimEnd();
  if (!t) removeRaw(draftKey(projectId));
  else writeRaw(draftKey(projectId), text);
}

export function clearComposerDraft(projectId: string): void {
  removeRaw(draftKey(projectId));
}

// ── chat mode / auto-apply ──────────────────────────────────────────────────

export function loadChatMode(projectId: string): ChatModePref {
  const v = readRaw(modeKey(projectId));
  return v === 'ask' ? 'ask' : 'agent';
}

export function saveChatMode(projectId: string, mode: ChatModePref): void {
  writeRaw(modeKey(projectId), mode);
}

export function loadChatAutoApply(projectId: string): boolean {
  return readRaw(autoApplyKey(projectId)) === '1';
}

export function saveChatAutoApply(projectId: string, on: boolean): void {
  writeRaw(autoApplyKey(projectId), on ? '1' : '0');
}

// ── legacy current-timeline playhead (frame) ───────────────────────────────

export function loadPlayhead(projectId: string): number {
  const frame = Number(readRaw(playheadKey(projectId)));
  return Number.isFinite(frame) && frame > 0 ? Math.floor(frame) : 0;
}

export function savePlayhead(projectId: string, frame: number): void {
  const normalized = Math.max(0, Math.floor(frame));
  if (normalized <= 0) removeRaw(playheadKey(projectId));
  else writeRaw(playheadKey(projectId), String(normalized));
}

// ── per-timeline editor view ────────────────────────────────────────────────

function browserViewStorage(): TimelineViewStorage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadTimelineView(projectId: string, timelineId: string): TimelineViewState | null {
  const storage = browserViewStorage();
  return storage ? loadTimelineViewState(storage, projectId, timelineId) : null;
}

export function saveTimelineView(projectId: string, timelineId: string, patch: Partial<TimelineViewState>): void {
  const storage = browserViewStorage();
  if (storage) saveTimelineViewState(storage, projectId, timelineId, patch);
}

/** Permanently remove all browser-local UI continuity for one deleted project. */
export function clearProjectSessionPrefs(projectId: string): void {
  for (const key of [
    draftKey(projectId),
    modeKey(projectId),
    autoApplyKey(projectId),
    playheadKey(projectId),
  ]) removeRaw(key);
  const storage = browserViewStorage();
  if (storage) clearTimelineViewStates(storage, projectId);
}

// ── recent MG templates (global, not per-project) ───────────────────────────

export function loadRecentTemplateIds(): string[] {
  try {
    const raw = readRaw(RECENT_TEMPLATES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function pushRecentTemplateId(id: string): string[] {
  const next = [id, ...loadRecentTemplateIds().filter((x) => x !== id)].slice(0, MAX_RECENT);
  writeRaw(RECENT_TEMPLATES_KEY, JSON.stringify(next));
  return next;
}
