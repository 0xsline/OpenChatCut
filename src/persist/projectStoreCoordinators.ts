import type { ProjectDoc } from '../editor/types';

export interface ProjectMeta {
  id: string;
  name: string;
  updatedAt: number;
  /** Soft-delete timestamp; absent means active. */
  deletedAt?: number;
  /** Optional free-text project description. */
  description?: string;
}

export interface ProjectSaveResult {
  projectId: string;
  revision: number;
  epoch: number;
  status: 'saved' | 'failed' | 'superseded';
  saved: boolean;
  indexUpdated: boolean;
  error?: unknown;
}

export interface ProjectFlushEntry {
  projectId: string;
  ok: boolean;
  pending: number;
  revision: number;
  result?: ProjectSaveResult;
}

export interface ProjectFlushResult {
  ok: boolean;
  projects: ProjectFlushEntry[];
}

interface ProjectSaveState {
  epoch: number;
  nextRevision: number;
  pending: number;
  tail: Promise<void>;
  lastResult?: ProjectSaveResult;
  blocked?: unknown;
}

type PersistProjectSnapshot = (
  projectId: string,
  snapshot: ProjectDoc,
) => Promise<{ saved: boolean; indexUpdated: boolean }>;

function immutableProjectSnapshot(doc: ProjectDoc): ProjectDoc {
  try {
    return structuredClone(doc);
  } catch {
    return JSON.parse(JSON.stringify(doc)) as ProjectDoc;
  }
}

/** Serializes immutable project snapshots and retains the latest write outcome. */
export class SaveCoordinator {
  private readonly states = new Map<string, ProjectSaveState>();
  private readonly persist: PersistProjectSnapshot;
  private readonly snapshot: (doc: ProjectDoc) => ProjectDoc;


  constructor(
    persist: PersistProjectSnapshot,
    snapshot: (doc: ProjectDoc) => ProjectDoc = immutableProjectSnapshot,
  ) {
    this.persist = persist;
    this.snapshot = snapshot;
  }

  private stateFor(projectId: string): ProjectSaveState {
    let state = this.states.get(projectId);
    if (!state) {
      state = { epoch: 0, nextRevision: 0, pending: 0, tail: Promise.resolve() };
      this.states.set(projectId, state);
    }
    return state;
  }

  private async persistRevision(
    state: ProjectSaveState,
    projectId: string,
    snapshot: ProjectDoc,
    revision: number,
    epoch: number,
  ): Promise<ProjectSaveResult> {
    if (state.epoch !== epoch) {
      return { projectId, revision, epoch, status: 'superseded', saved: false, indexUpdated: false };
    }
    try {
      const persisted = await this.persist(projectId, snapshot);
      if (!persisted.saved) {
        return {
          projectId, revision, epoch, status: 'failed', saved: false,
          indexUpdated: persisted.indexUpdated, error: new Error('project save failed'),
        };
      }
      return {
        projectId, revision, epoch, status: 'saved', saved: true,
        indexUpdated: persisted.indexUpdated,
      };
    } catch (error) {
      return {
        projectId, revision, epoch, status: 'failed', saved: false, indexUpdated: false, error,
      };
    }
  }

  enqueue(projectId: string, doc: ProjectDoc): Promise<ProjectSaveResult> {
    const state = this.stateFor(projectId);
    if (state.blocked !== undefined) {
      return Promise.resolve({
        projectId, revision: state.nextRevision, epoch: state.epoch, status: 'failed',
        saved: false, indexUpdated: false, error: state.blocked,
      });
    }
    const snapshot = this.snapshot(doc);
    const revision = ++state.nextRevision;
    const epoch = state.epoch;
    state.pending += 1;
    const result = state.tail.then(() =>
      this.persistRevision(state, projectId, snapshot, revision, epoch));
    state.tail = result.then((value) => {
      state.lastResult = value;
      state.pending -= 1;
    }, (error) => {
      state.lastResult = {
        projectId, revision, epoch, status: 'failed', saved: false, indexUpdated: false, error,
      };
      state.pending -= 1;
    });
    return result;
  }

  async flush(projectId: string | 'all' = 'all'): Promise<ProjectFlushResult> {
    const ids = projectId === 'all' ? [...this.states.keys()] : [projectId];
    const projects = await Promise.all(ids.map(async (id): Promise<ProjectFlushEntry> => {
      const state = this.states.get(id);
      if (!state) return { projectId: id, ok: true, pending: 0, revision: 0 };
      for (;;) {
        const tail = state.tail;
        await tail;
        if (state.pending === 0 && state.tail === tail) break;
      }
      const result = state.lastResult;
      return {
        projectId: id,
        ok: state.blocked === undefined && result?.status !== 'failed',
        pending: state.pending,
        revision: state.nextRevision,
        ...(result ? { result } : {}),
      };
    }));
    return { ok: projects.every((entry) => entry.ok), projects };
  }

  hasPending(projectId?: string): boolean {
    if (projectId !== undefined) return (this.states.get(projectId)?.pending ?? 0) > 0;
    return [...this.states.values()].some((state) => state.pending > 0);
  }

  hasFailure(projectId?: string): boolean {
    const failed = (state: ProjectSaveState | undefined) =>
      state?.blocked !== undefined || (state?.pending === 0 && state.lastResult?.status === 'failed');
    if (projectId !== undefined) return failed(this.states.get(projectId)) === true;
    return [...this.states.values()].some(failed);
  }

  invalidate(projectId: string): void {
    const state = this.stateFor(projectId);
    state.epoch += 1;
    state.blocked = new Error('project save queue was invalidated');
  }

  reset(): void {
    this.states.clear();
  }
}

export interface ProjectIndexMutation<T> {
  /** null means the operation was a read/no-op and must not rewrite the index. */
  next: ProjectMeta[] | null;
  value: T;
}

type ReadProjectIndex = () => Promise<ProjectMeta[]>;
type WriteProjectIndex = (index: ProjectMeta[]) => Promise<void>;

/** Owns every project-index read-modify-write transaction. */
export class ProjectIndexCoordinator {
  private tail: Promise<void> = Promise.resolve();
  private readonly readStore: ReadProjectIndex;
  private readonly writeStore: WriteProjectIndex;


  constructor(readStore: ReadProjectIndex, writeStore: WriteProjectIndex) {
    this.readStore = readStore;
    this.writeStore = writeStore;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.catch(() => undefined).then(operation);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  read(): Promise<ProjectMeta[]> {
    return this.enqueue(() => this.readStore());
  }

  mutate<T>(
    operation: (current: ProjectMeta[]) => ProjectIndexMutation<T> | Promise<ProjectIndexMutation<T>>,
  ): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.readStore();
      const mutation = await operation(current);
      if (mutation.next !== null) await this.writeStore(mutation.next);
      return mutation.value;
    });
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  reset(): void {
    this.tail = Promise.resolve();
  }
}
