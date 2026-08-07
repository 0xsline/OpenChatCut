import { randomUUID } from 'node:crypto';
import {
  getStoredEntry,
  withProjectStoreLock,
  type LockedProjectStore,
  type StoredEntryValue,
} from '../plugins/project-store.ts';
import { runProjectMigrations } from '../../src/persist/migrations/index.ts';
import {
  revisionOf,
  type ExternalDraftCheckpoint,
} from '../../src/agent/external-edit-session.ts';
import type { Operation } from '../../src/agent/proposal.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';

const VALID_PROJECT_ID = /^[a-zA-Z0-9_-]{1,160}$/;
const MAX_AUTOMATIC_VERSIONS = 30;
const MAX_METADATA_RETRIES = 4;
const CHECKPOINT_PREFIX = 'offline-edit-session:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedOperation(value: unknown): Operation | null {
  if (!isRecord(value) || typeof value.tool !== 'string' || !isRecord(value.args)
    || typeof value.action !== 'string' || typeof value.target !== 'string'
    || typeof value.impact !== 'string' || !Array.isArray(value.actions)) return null;
  const actions = value.actions.filter((action) => isRecord(action) && typeof action.type === 'string');
  if (actions.length !== value.actions.length) return null;
  return {
    tool: value.tool,
    args: value.args,
    actions: actions as Operation['actions'],
    action: value.action,
    target: value.target,
    impact: value.impact,
    ...(typeof value.callCount === 'number' ? { callCount: value.callCount } : {}),
    ...(typeof value.rationale === 'string' ? { rationale: value.rationale } : {}),
  };
}

function normalizedCheckpoint(
  value: unknown,
  expectedRevision: string,
): ExternalDraftCheckpoint | null {
  if (!isRecord(value) || value.version !== 1 || value.baseRevision !== expectedRevision
    || typeof value.sessionId !== 'string' || typeof value.clientName !== 'string'
    || (value.approvalMode !== 'auto' && value.approvalMode !== 'manual')
    || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number'
    || !Array.isArray(value.operations)) return null;
  const draftDoc = normalizedProject(value.draftDoc);
  const operations = value.operations.map(normalizedOperation);
  if (!draftDoc || operations.some((operation) => operation === null)) return null;
  return {
    version: 1,
    sessionId: value.sessionId,
    clientName: value.clientName,
    approvalMode: value.approvalMode,
    baseRevision: expectedRevision,
    draftDoc,
    operations: operations as Operation[],
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export interface OfflineStoredProject {
  projectId: string;
  doc: ProjectDoc;
  revision: string;
}

export type OfflineProjectCommitStatus =
  | 'applied'
  | 'stale'
  | 'browser-takeover'
  | 'metadata-conflict';

export interface OfflineProjectCommitResult {
  status: OfflineProjectCommitStatus;
  revision?: string;
  automaticVersionCreated?: boolean;
}

export interface OfflineProjectCommitInput {
  projectId: string;
  expectedRevision: string;
  doc: ProjectDoc;
  canCommit: () => boolean;
}

interface CommitMetadata {
  projects: StoredEntryValue;
  versions: StoredEntryValue;
}

interface CommitAttemptInput extends OfflineProjectCommitInput {
  metadata: CommitMetadata;
  normalizedDoc: ProjectDoc;
}

class BrowserTakeoverError extends Error {}

function normalizedProject(value: unknown): ProjectDoc | null {
  return runProjectMigrations(value)?.doc ?? null;
}

function entryToken(entry: StoredEntryValue): string {
  return JSON.stringify([entry.found, entry.value]);
}

function automaticVersionEntries(value: unknown, before: ProjectDoc, now: number): {
  entries: unknown[];
  created: boolean;
} {
  const current = Array.isArray(value) ? value : [];
  let latest: unknown = null;
  let latestAt = -1;
  for (const entry of current) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const createdAt = 'createdAt' in entry && typeof entry.createdAt === 'number'
      ? entry.createdAt
      : -1;
    if (createdAt > latestAt) {
      latest = entry;
      latestAt = createdAt;
    }
  }
  const latestDoc = latest && typeof latest === 'object' && 'doc' in latest
    ? normalizedProject(latest.doc)
    : null;
  if (latestDoc && JSON.stringify(latestDoc) === JSON.stringify(before)) {
    return { entries: current, created: false };
  }
  const added = [{
    id: randomUUID(),
    name: '离线编辑前自动版本',
    createdAt: now,
    automatic: true,
    doc: before,
  }, ...current];
  let automaticCount = 0;
  return {
    entries: added.filter((entry) => {
      const automatic = entry !== null
        && typeof entry === 'object'
        && !Array.isArray(entry)
        && 'automatic' in entry
        && entry.automatic === true;
      if (!automatic) return true;
      automaticCount += 1;
      return automaticCount <= MAX_AUTOMATIC_VERSIONS;
    }),
    created: true,
  };
}

function updatedProjectIndex(value: unknown, projectId: string, now: number): unknown[] {
  const current = Array.isArray(value) ? value : [];
  let found = false;
  const updated = current.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    if (!('id' in entry) || entry.id !== projectId) return entry;
    found = true;
    return { ...entry, updatedAt: now };
  });
  if (!found) updated.push({ id: projectId, name: projectId, updatedAt: now });
  return updated.sort((left, right) => {
    const time = (entry: unknown): number => {
      if (!entry || typeof entry !== 'object' || !('updatedAt' in entry)) return 0;
      return typeof entry.updatedAt === 'number' ? entry.updatedAt : 0;
    };
    return time(right) - time(left);
  });
}

async function restoreEntries(
  store: LockedProjectStore,
  written: readonly string[],
  originals: Readonly<Record<string, StoredEntryValue>>,
): Promise<void> {
  for (const key of [...written].reverse()) {
    const original = originals[key];
    if (original.found) await store.writeEntry(key, original.value);
    else await store.removeEntry(key);
  }
}

async function writeCommitEntries(
  store: LockedProjectStore,
  changes: Readonly<Record<string, unknown>>,
  originals: Readonly<Record<string, StoredEntryValue>>,
  canCommit: () => boolean,
): Promise<void> {
  const written: string[] = [];
  try {
    for (const [key, value] of Object.entries(changes)) {
      if (!canCommit()) throw new BrowserTakeoverError();
      await store.writeEntry(key, value);
      written.push(key);
    }
    if (!canCommit()) throw new BrowserTakeoverError();
  } catch (error) {
    await restoreEntries(store, written, originals);
    throw error;
  }
}

async function readCommitMetadata(projectId: string): Promise<CommitMetadata> {
  const [projects, versions] = await Promise.all([
    getStoredEntry('projects'),
    getStoredEntry(`versions:${projectId}`),
  ]);
  return { projects, versions };
}

function metadataMatches(current: CommitMetadata, expected: CommitMetadata): boolean {
  return entryToken(current.projects) === entryToken(expected.projects)
    && entryToken(current.versions) === entryToken(expected.versions);
}

async function attemptCommit(input: CommitAttemptInput): Promise<OfflineProjectCommitResult> {
  const projectKey = `project:${input.projectId}`;
  const versionsKey = `versions:${input.projectId}`;
  try {
    return await withProjectStoreLock<OfflineProjectCommitResult>(async (store) => {
      const project = await store.readEntry(projectKey);
      const before = project.found ? normalizedProject(project.value) : null;
      if (!before || revisionOf(before) !== input.expectedRevision) return { status: 'stale' };
      const currentMetadata = {
        projects: await store.readEntry('projects'),
        versions: await store.readEntry(versionsKey),
      };
      if (!metadataMatches(currentMetadata, input.metadata)) return { status: 'metadata-conflict' };
      if (!input.canCommit()) return { status: 'browser-takeover' };
      const now = Date.now();
      const versions = automaticVersionEntries(currentMetadata.versions.value, before, now);
      const changes = {
        [versionsKey]: versions.entries,
        projects: updatedProjectIndex(currentMetadata.projects.value, input.projectId, now),
        [projectKey]: input.normalizedDoc,
      };
      const originals = {
        [versionsKey]: currentMetadata.versions,
        projects: currentMetadata.projects,
        [projectKey]: project,
      };
      await writeCommitEntries(store, changes, originals, input.canCommit);
      return {
        status: 'applied',
        revision: revisionOf(input.normalizedDoc),
        automaticVersionCreated: versions.created,
      };
    });
  } catch (error) {
    if (error instanceof BrowserTakeoverError) return { status: 'browser-takeover' };
    throw error;
  }
}

export async function loadOfflineStoredProject(projectId: string): Promise<OfflineStoredProject | null> {
  if (!VALID_PROJECT_ID.test(projectId)) throw new Error('invalid project id');
  const entry = await getStoredEntry(`project:${projectId}`);
  const doc = entry.found ? normalizedProject(entry.value) : null;
  return doc ? { projectId, doc, revision: revisionOf(doc) } : null;
}
export type OfflineCheckpointSaveStatus = 'saved' | 'stale' | 'browser-takeover';
export interface OfflineCheckpointSaveInput {
  projectId: string;
  expectedRevision: string;
  checkpoint: ExternalDraftCheckpoint;
  canSave: () => boolean;
}


export async function loadOfflineEditCheckpoint(
  projectId: string,
  expectedRevision: string,
): Promise<ExternalDraftCheckpoint | null> {
  if (!VALID_PROJECT_ID.test(projectId)) throw new Error('invalid project id');
  const entry = await getStoredEntry(`${CHECKPOINT_PREFIX}${projectId}`);
  return entry.found ? normalizedCheckpoint(entry.value, expectedRevision) : null;
}

export async function saveOfflineEditCheckpoint(
  input: OfflineCheckpointSaveInput,
): Promise<OfflineCheckpointSaveStatus> {
  if (!VALID_PROJECT_ID.test(input.projectId)) throw new Error('invalid project id');
  const checkpoint = normalizedCheckpoint(input.checkpoint, input.expectedRevision);
  if (!checkpoint) throw new Error('invalid offline edit checkpoint');
  return withProjectStoreLock(async (store) => {
    const project = await store.readEntry(`project:${input.projectId}`);
    const doc = project.found ? normalizedProject(project.value) : null;
    if (!doc || revisionOf(doc) !== input.expectedRevision) return 'stale';
    if (!input.canSave()) return 'browser-takeover';
    const key = `${CHECKPOINT_PREFIX}${input.projectId}`;
    const previous = await store.readEntry(key);
    await store.writeEntry(key, checkpoint);
    if (input.canSave()) return 'saved';
    if (previous.found) await store.writeEntry(key, previous.value);
    else await store.removeEntry(key);
    return 'browser-takeover';
  });
}

export async function deleteOfflineEditCheckpoint(
  projectId: string,
  sessionId: string,
): Promise<void> {
  if (!VALID_PROJECT_ID.test(projectId)) throw new Error('invalid project id');
  await withProjectStoreLock(async (store) => {
    const key = `${CHECKPOINT_PREFIX}${projectId}`;
    const current = await store.readEntry(key);
    if (current.found && isRecord(current.value) && current.value.sessionId === sessionId) {
      await store.removeEntry(key);
    }
  });
}

export async function commitOfflineStoredProject(
  input: OfflineProjectCommitInput,
): Promise<OfflineProjectCommitResult> {
  if (!VALID_PROJECT_ID.test(input.projectId)) throw new Error('invalid project id');
  const normalizedDoc = normalizedProject(input.doc);
  if (!normalizedDoc) throw new Error('invalid edited project document');
  for (let attempt = 0; attempt < MAX_METADATA_RETRIES; attempt += 1) {
    const metadata = await readCommitMetadata(input.projectId);
    const result = await attemptCommit({ ...input, normalizedDoc, metadata });
    if (result.status !== 'metadata-conflict') return result;
  }
  return { status: 'metadata-conflict' };
}
