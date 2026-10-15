import type { ProjectDoc } from '../editor/types';
import type { ProjectSaveResult } from '../persist/projectStoreCoordinators';

interface ProposalDocumentCommit {
  projectId: string;
  before: ProjectDoc;
  result: ProjectDoc;
  versionLabel: string;
  signal?: AbortSignal;
}

interface ProposalCommitAdapter {
  saveVersion(projectId: string, label: string, doc: ProjectDoc): Promise<unknown>;
  saveDoc(projectId: string, doc: ProjectDoc): Promise<ProjectSaveResult>;
  getDoc(): ProjectDoc;
  isCurrent(): boolean;
  stage?(): Promise<void>;
}

type ProposalDocumentCommitResult =
  | { status: 'saved'; save: ProjectSaveResult }
  | { status: 'stale' | 'cancelled' | 'save-failed' | 'restore-failed' };

/** Save the pre-edit version and restore newer live edits if a write is interrupted. */
export async function commitProposalDocument(
  input: ProposalDocumentCommit,
  adapter: ProposalCommitAdapter,
): Promise<ProposalDocumentCommitResult> {
  const interrupted = (): 'stale' | 'cancelled' | null => input.signal?.aborted
    ? 'cancelled'
    : adapter.isCurrent() ? null : 'stale';
  await adapter.saveVersion(input.projectId, input.versionLabel, input.before);
  const beforeStage = interrupted();
  if (beforeStage) return { status: beforeStage };
  if (adapter.stage) {
    await adapter.stage();
    const beforeSave = interrupted();
    if (beforeSave) return { status: beforeSave };
  }
  const save = await adapter.saveDoc(input.projectId, input.result);
  if (!save.saved) return { status: 'save-failed' };
  const afterSave = interrupted();
  if (afterSave) {
    const restored = await adapter.saveDoc(input.projectId, adapter.getDoc()).catch(() => null);
    return { status: restored?.saved ? afterSave : 'restore-failed' };
  }
  return { status: 'saved', save };
}
