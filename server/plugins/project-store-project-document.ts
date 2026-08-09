import type {
  ProjectDocumentMutationResponse,
  ProjectStoreRequest,
} from '../../shared/project-store-transport.ts';
import { revisionOf } from '../../src/agent/external-edit-session.ts';
import type { ProjectDoc } from '../../src/editor/types.ts';
import { runProjectMigrations } from '../../src/persist/migrations/index.ts';
import {
  projectEditOwnershipKey,
  projectEditOwnershipMatches,
  renewedProjectEditOwnership,
  type ProjectEditOwnershipClaim,
} from '../external-agent/project-edit-ownership-codec.ts';
import type { LockedProjectStore, StoredEntryValue } from './project-store.ts';

type ProjectDocumentCasRequest = Extract<
  ProjectStoreRequest,
  { operation: 'project-document-cas' }
>;
type ProjectDocumentUpdateRequest = Extract<
  ProjectDocumentCasRequest,
  { expectedRevision: string }
>;
type WithStoreLock = <T>(
  work: (store: LockedProjectStore) => Promise<T>,
) => Promise<T>;

const normalizedProject = (value: unknown): ProjectDoc | null =>
  runProjectMigrations(value)?.doc ?? null;

function mutationResponse(
  entry: StoredEntryValue,
  accepted: boolean,
  currentRevision?: string,
  ownershipEpoch?: number,
): ProjectDocumentMutationResponse {
  return {
    accepted,
    found: entry.found,
    ...(entry.found ? { value: entry.value } : {}),
    ...(currentRevision ? { currentRevision } : {}),
    ...(ownershipEpoch === undefined ? {} : { ownershipEpoch }),
  };
}

async function restoreEntry(
  store: LockedProjectStore,
  key: string,
  original: StoredEntryValue,
): Promise<void> {
  if (original.found) await store.writeEntryExact(key, original.value);
  else await store.removeEntry(key);
}

async function createProjectDocument(
  store: LockedProjectStore,
  request: ProjectDocumentCasRequest,
  project: ProjectDoc,
): Promise<ProjectDocumentMutationResponse> {
  const projectId = request.key.slice('project:'.length);
  const ownership = await store.readEntry(projectEditOwnershipKey(projectId));
  if (ownership.found) return mutationResponse({ found: false }, false);
  await store.writeEntryExact(request.key, project);
  return mutationResponse({ found: true, value: project }, true, revisionOf(project));
}

async function updateProjectDocument(
  store: LockedProjectStore,
  request: ProjectDocumentUpdateRequest,
  current: StoredEntryValue,
  project: ProjectDoc,
  projectId: string,
): Promise<ProjectDocumentMutationResponse> {
  const ownershipKey = projectEditOwnershipKey(projectId);
  const ownership = await store.readEntry(ownershipKey);
  const claim: ProjectEditOwnershipClaim = {
    projectId,
    ownerKind: 'browser',
    ownerId: request.ownerId,
    epoch: request.ownershipEpoch,
    baseRevision: request.expectedRevision,
  };
  if (!projectEditOwnershipMatches(ownership.value, claim)) {
    return mutationResponse(current, false, request.expectedRevision);
  }
  const nextRevision = revisionOf(project);
  try {
    await store.writeEntryExact(request.key, project);
    await store.writeEntryExact(
      ownershipKey,
      renewedProjectEditOwnership(claim, nextRevision),
    );
  } catch (error) {
    await restoreEntry(store, request.key, current);
    await restoreEntry(store, ownershipKey, ownership);
    throw error;
  }
  return mutationResponse(
    { found: true, value: project },
    true,
    nextRevision,
    claim.epoch,
  );
}

export function createProjectDocumentStoreOperation(withStoreLock: WithStoreLock) {
  return async (request: ProjectDocumentCasRequest): Promise<ProjectDocumentMutationResponse> => (
    withStoreLock(async (store) => {
      const current = await store.readEntry(request.key);
      const currentDoc = current.found ? normalizedProject(current.value) : null;
      if (current.found && !currentDoc) {
        throw new Error('stored project document is corrupt or unsupported');
      }
      const currentRevision = currentDoc ? revisionOf(currentDoc) : null;
      if (currentRevision !== request.expectedRevision) {
        return mutationResponse(current, false, currentRevision ?? undefined);
      }
      const project = normalizedProject(request.value);
      if (!project) throw new Error('project document CAS value is invalid or unsupported');
      const projectId = request.key.slice('project:'.length);
      return request.expectedRevision === null
        ? createProjectDocument(store, request, project)
        : updateProjectDocument(store, request, current, project, projectId);
    })
  );
}
