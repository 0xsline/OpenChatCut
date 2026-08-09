import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version.ts';
import {
  revisionOf,
  type ExternalDraftCheckpoint,
} from '../../src/agent/external-edit-session.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';
import type { OfflineEditPersistence } from './offline-runtime.ts';
import type {
  OfflineCheckpointSaveInput,
  OfflineProjectCommitInput,
} from './offline-project-store.ts';
import type { ProjectEditOwnershipClaim } from './project-edit-ownership.ts';

export const projectId = 'offline-project';
export const editorUrl = `http://localhost:5173/#/editor/${projectId}`;

export function projectDoc(width = 1920, height = 1080): ProjectDoc {
  return {
    version: CURRENT_PROJECT_VERSION,
    assets: [],
    mediaFolders: [],
    activeTimelineId: 'timeline-1',
    timelines: [{
      id: 'timeline-1',
      name: 'Timeline 1',
      order: 0,
      fps: 30,
      width,
      height,
      items: [],
      selectedId: null,
      trackOrder: ['track-v1'],
      tracks: { 'track-v1': { kind: 'video' } },
    }],
  };
}

export class MemoryPersistence implements OfflineEditPersistence {
  current: ProjectDoc;
  versions: ProjectDoc[] = [];
  commitCount = 0;
  checkpoint: ExternalDraftCheckpoint | null = null;
  ownership: ProjectEditOwnershipClaim | null = null;
  epoch = 0;

  constructor(doc: ProjectDoc) {
    this.current = structuredClone(doc);
  }

  async claimProject(id: string, ownerId: string) {
    if (id !== projectId || this.ownership) {
      return { status: id === projectId ? 'busy' as const : 'missing' as const };
    }
    const doc = structuredClone(this.current);
    const revision = revisionOf(doc);
    this.ownership = {
      projectId: id,
      ownerKind: 'offline',
      ownerId,
      epoch: ++this.epoch,
      baseRevision: revision,
    };
    return { status: 'claimed' as const, claim: this.ownership, doc, revision };
  }

  async renewOwnership(claim: ProjectEditOwnershipClaim, baseRevision = claim.baseRevision) {
    if (!this.matches(claim) || revisionOf(this.current) !== baseRevision) {
      return { status: 'stale' as const };
    }
    this.ownership = { ...claim, baseRevision };
    return { status: 'renewed' as const, claim: this.ownership, doc: structuredClone(this.current) };
  }

  async releaseOwnership(claim: ProjectEditOwnershipClaim): Promise<void> {
    if (this.matches(claim)) this.ownership = null;
  }

  async loadCheckpoint(
    id: string,
    expectedRevision: string,
  ): Promise<ExternalDraftCheckpoint | null> {
    if (id !== projectId || this.checkpoint?.baseRevision !== expectedRevision) return null;
    return structuredClone(this.checkpoint);
  }

  async saveCheckpoint(input: OfflineCheckpointSaveInput) {
    if (!this.matches(input.ownership)
      || input.projectId !== projectId
      || revisionOf(this.current) !== input.expectedRevision) return 'stale' as const;
    if (!input.canSave()) return 'browser-takeover' as const;
    this.checkpoint = structuredClone(input.checkpoint);
    if (input.canSave()) return 'saved' as const;
    this.checkpoint = null;
    return 'browser-takeover' as const;
  }

  async deleteCheckpoint(
    id: string,
    sessionId: string,
    ownership: ProjectEditOwnershipClaim,
  ): Promise<void> {
    if (this.matches(ownership) && id === projectId && this.checkpoint?.sessionId === sessionId) {
      this.checkpoint = null;
    }
  }

  async commitProject(input: OfflineProjectCommitInput) {
    if (!this.matches(input.ownership) || !input.canCommit()) {
      return { status: 'browser-takeover' as const };
    }
    if (revisionOf(this.current) !== input.expectedRevision) return { status: 'stale' as const };
    this.versions.push(structuredClone(this.current));
    this.current = structuredClone(input.doc);
    this.commitCount += 1;
    const revision = revisionOf(this.current);
    this.ownership = { ...input.ownership, baseRevision: revision };
    return {
      status: 'applied' as const,
      revision,
      automaticVersionCreated: true,
      ownership: this.ownership,
    };
  }

  private matches(claim: ProjectEditOwnershipClaim): boolean {
    return this.ownership?.ownerId === claim.ownerId
      && this.ownership.epoch === claim.epoch
      && this.ownership.baseRevision === claim.baseRevision;
  }
}

export function editSessionId(value: unknown): string {
  assert(value && typeof value === 'object' && 'editSessionId' in value);
  const id = value.editSessionId;
  assert.equal(typeof id, 'string');
  return id;
}

export function agentRunId(value: unknown): string {
  assert(value && typeof value === 'object' && 'agentRunId' in value);
  const id = value.agentRunId;
  assert.equal(typeof id, 'string');
  return id;
}
