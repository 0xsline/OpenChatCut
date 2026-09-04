import { runProjectMigrations } from '../../src/persist/migrations/index.ts';
import { revisionOf } from '../../src/agent/external-edit-session.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';
import {
  withSerializedProjectStore,
  type LockedProjectStore,
  type StoredEntryValue,
} from '../plugins/project-store.ts';
import {
  parseProjectEditOwnership,
  projectEditOwnershipKey,
  renewedProjectEditOwnership,
  validProjectEditOwnershipIdentity,
  type ProjectEditOwnershipClaim,
} from './project-edit-ownership-codec.ts';
export {
  projectEditOwnershipKey,
  projectEditOwnershipMatches,
  renewedProjectEditOwnership,
} from './project-edit-ownership-codec.ts';
export type { ProjectEditOwnershipClaim } from './project-edit-ownership-codec.ts';


export type BrowserOwnershipClaimResult =
  | { status: 'claimed'; claim: ProjectEditOwnershipClaim }
  | { status: 'stale'; currentRevision?: string }
  | { status: 'blocked' };

export type OfflineOwnershipClaimResult =
  | { status: 'claimed'; claim: ProjectEditOwnershipClaim; doc: ProjectDoc; revision: string }
  | { status: 'busy' | 'missing' | 'blocked' };

export type OwnershipRenewResult =
  | { status: 'renewed'; claim: ProjectEditOwnershipClaim; doc: ProjectDoc }
  | { status: 'stale' | 'blocked' };


function normalizedProject(value: unknown): ProjectDoc | null {
  return runProjectMigrations(value)?.doc ?? null;
}


function ownershipCompatibility(entry: StoredEntryValue, projectId: string): 'absent' | 'current' | 'blocked' {
  if (!entry.found) return 'absent';
  return parseProjectEditOwnership(entry.value, projectId) ? 'current' : 'blocked';
}


async function storedProject(
  store: LockedProjectStore,
  projectId: string,
): Promise<{ doc: ProjectDoc; revision: string } | null> {
  const entry = await store.readEntry(`project:${projectId}`);
  const doc = entry.found ? normalizedProject(entry.value) : null;
  return doc ? { doc, revision: revisionOf(doc) } : null;
}

export async function claimBrowserProjectOwnership(
  projectId: string,
  ownerId: string,
  expectedRevision: string,
  _allowExistingBrowserOwner = false,
): Promise<BrowserOwnershipClaimResult> {
  if (!validProjectEditOwnershipIdentity(projectId, ownerId) || !expectedRevision) {
    return { status: 'blocked' };
  }
  return withSerializedProjectStore(async (store) => {
    const project = await storedProject(store, projectId);
    if (!project || project.revision !== expectedRevision) {
      return { status: 'stale', currentRevision: project?.revision };
    }
    const entry = await store.readEntry(projectEditOwnershipKey(projectId));
    const compatibility = ownershipCompatibility(entry, projectId);
    if (compatibility === 'blocked') return { status: 'blocked' };
    const current = compatibility === 'current' ? parseProjectEditOwnership(entry.value, projectId)! : null;
    const sameOwner = current?.ownerKind === 'browser'
      && current.ownerId === ownerId
      && current.leaseExpiresAt > Date.now();
    // A browser window that already owns this project (the same ownerId, still a
    // live lease) may re-claim it even without its in-memory capability. In
    // normal single-window use the bridge occasionally tears down and reconnects
    // with the same editor id but no capability; blocking that re-claim produced
    // a spurious 409 that flashed "close the other window" during routine use.
    // Genuine anti-spoof is enforced at the registration-route capability layer
    // (broker capabilityMatches / the route's renewing check), so this claim
    // gate only needs to fence cross-layer writes, not same-owner recovery.
    // A genuinely DIFFERENT browser window that holds the expected revision also
    // takes over from a previously registered browser window. Single-window
    // desktop users never open the same project in two windows, so there is no
    // cross-browser exclusivity to enforce. We still refuse to steal from a live
    // OFFLINE writer (external MCP / a serialized offline commit) or an
    // epoch-pinned owner, so the browser cannot clobber a non-browser write in
    // flight. Lost-update protection additionally holds via the CAS revision
    // match in createProjectDocumentStoreOperation.
    if (current && current.leaseExpiresAt > Date.now() && current.ownerKind !== 'browser') {
      return { status: 'blocked' };
    }
    if (current && current.epoch === Number.MAX_SAFE_INTEGER) return { status: 'blocked' };
    const claim: ProjectEditOwnershipClaim = {
      projectId,
      ownerKind: 'browser',
      ownerId,
      epoch: sameOwner ? current.epoch : (current?.epoch ?? 0) + 1,
      baseRevision: expectedRevision,
    };
    await store.writeEntry(projectEditOwnershipKey(projectId), renewedProjectEditOwnership(claim, expectedRevision));
    return { status: 'claimed', claim };
  });
}

export async function claimOfflineProjectOwnership(
  projectId: string,
  ownerId: string,
): Promise<OfflineOwnershipClaimResult> {
  if (!validProjectEditOwnershipIdentity(projectId, ownerId)) {
    return { status: 'blocked' };
  }
  return withSerializedProjectStore(async (store) => {
    const project = await storedProject(store, projectId);
    if (!project) return { status: 'missing' };
    const entry = await store.readEntry(projectEditOwnershipKey(projectId));
    const compatibility = ownershipCompatibility(entry, projectId);
    if (compatibility === 'blocked') return { status: 'blocked' };
    const current = compatibility === 'current' ? parseProjectEditOwnership(entry.value, projectId)! : null;
    if (current && current.leaseExpiresAt > Date.now()) return { status: 'busy' };
    if (current?.epoch === Number.MAX_SAFE_INTEGER) return { status: 'blocked' };
    const claim: ProjectEditOwnershipClaim = {
      projectId,
      ownerKind: 'offline',
      ownerId,
      epoch: (current?.epoch ?? 0) + 1,
      baseRevision: project.revision,
    };
    await store.writeEntry(projectEditOwnershipKey(projectId), renewedProjectEditOwnership(claim, project.revision));
    return { status: 'claimed', claim, ...project };
  });
}

export async function renewProjectEditOwnership(
  claim: ProjectEditOwnershipClaim,
  _baseRevision = claim.baseRevision,
): Promise<OwnershipRenewResult> {
  return withSerializedProjectStore(async (store) => {
    const ownership = await store.readEntry(projectEditOwnershipKey(claim.projectId));
    if (ownershipCompatibility(ownership, claim.projectId) === 'blocked') return { status: 'blocked' };
    const current = parseProjectEditOwnership(ownership.value, claim.projectId);
    if (!current
      || current.ownerKind !== claim.ownerKind
      || current.ownerId !== claim.ownerId
      || current.epoch !== claim.epoch
      || current.leaseExpiresAt <= Date.now()) return { status: 'stale' };
    const project = await storedProject(store, claim.projectId);
    if (!project || current.baseRevision !== project.revision) return { status: 'stale' };
    const renewed = { ...claim, baseRevision: project.revision };
    await store.writeEntry(
      projectEditOwnershipKey(claim.projectId),
      renewedProjectEditOwnership(renewed, project.revision),
    );
    return { status: 'renewed', claim: renewed, doc: project.doc };
  });
}

export async function releaseProjectEditOwnership(claim: ProjectEditOwnershipClaim): Promise<void> {
  await withSerializedProjectStore(async (store) => {
    const key = projectEditOwnershipKey(claim.projectId);
    const entry = await store.readEntry(key);
    const current = parseProjectEditOwnership(entry.value, claim.projectId);
    if (!current
      || current.ownerKind !== claim.ownerKind
      || current.ownerId !== claim.ownerId
      || current.epoch !== claim.epoch) return;
    await store.writeEntry(key, {
      ...renewedProjectEditOwnership(current, current.baseRevision),
      leaseExpiresAt: 0,
    });
  });
}
