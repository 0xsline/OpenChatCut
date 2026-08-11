import assert from 'node:assert/strict';
import type {
  DirectoryImportDisposition,
  DirectoryImportedFile,
  DirectoryImportEvent,
  DirectoryWatchStartResult,
} from '../shared/directory-import.ts';
import {
  DirectoryWatchController,
  type DirectoryWatchSender,
  type DirectoryWatchSessionContract,
} from './directory-watch-controller.ts';
import type { DirectoryWatchSessionOptions } from './directory-watch.ts';

const HASH = 'ab'.repeat(32);

class FakeSender implements DirectoryWatchSender {
  readonly sent: Array<{ channel: string; value: unknown }> = [];
  readonly id: number;
  private destroyed = false;
  private readonly destroyListeners: Array<() => void> = [];

  constructor(id: number) { this.id = id; }

  isDestroyed(): boolean { return this.destroyed; }
  send(channel: string, value: unknown): void { this.sent.push({ channel, value }); }
  once(_event: 'destroyed', listener: () => void): void { this.destroyListeners.push(listener); }

  destroy(): void {
    this.destroyed = true;
    this.destroyListeners.forEach((listener) => listener());
  }
}

class FakeSession implements DirectoryWatchSessionContract {
  readonly watchId: string;
  readonly projectId: string;
  readonly options: DirectoryWatchSessionOptions;
  activations = 0;
  stops = 0;
  acknowledgements: Array<{ importId: string; disposition: DirectoryImportDisposition }> = [];

  constructor(options: DirectoryWatchSessionOptions) {
    this.options = options;
    this.watchId = options.watchId;
    this.projectId = options.projectId;
  }

  async start(): Promise<DirectoryWatchStartResult> {
    return {
      watchId: this.watchId,
      projectId: this.projectId,
      directoryName: 'selected',
      files: [],
    };
  }

  async activate(): Promise<void> { this.activations += 1; }
  async stop(): Promise<void> { this.stops += 1; }
  async acknowledge(importId: string, disposition: DirectoryImportDisposition): Promise<void> {
    this.acknowledgements.push({ importId, disposition });
  }
}

function importedFile(importId: string): DirectoryImportedFile {
  return {
    importId,
    name: 'clip.mp4',
    src: `/media/uploads/${importId}.mp4`,
    storedName: `${importId}.mp4`,
    contentHash: HASH,
    kind: 'video',
    size: 42,
    sourceModifiedAt: 10,
    compatibilityNormalized: true,
  };
}

let selected = '/selected';
let uploadDirectory = '/media/uploads';
let idSequence = 0;
const sessions: FakeSession[] = [];
const controller = new DirectoryWatchController({
  selectDirectory: async () => selected,
  realpath: async (path) => path,
  canonicalUploadDirectory: async () => uploadDirectory,
  randomId: () => `watch-${++idSequence}`,
  createSession: (options) => {
    const session = new FakeSession(options);
    sessions.push(session);
    return session;
  },
  reportError: (error) => { throw error; },
});

const ownerA = new FakeSender(1);
const ownerB = new FakeSender(2);
selected = uploadDirectory;
await assert.rejects(
  controller.start(ownerA, 'project-a', []),
  /media destination cannot overlap/,
  'the upload root itself must be rejected',
);
selected = '/media';
await assert.rejects(
  controller.start(ownerA, 'project-a', []),
  /media destination cannot overlap/,
  'an ancestor containing the upload root must be rejected',
);
selected = '/media/uploads/child';
await assert.rejects(
  controller.start(ownerA, 'project-a', []),
  /media destination cannot overlap/,
  'a watched root inside the upload root must be rejected',
);


selected = '/media/sibling';
const startA = await controller.start(ownerA, 'project-a', []);
assert.equal(startA?.watchId, 'watch-1');
assert.equal(JSON.stringify(startA).includes('/media/sibling'), false, 'the selected path must remain private');
selected = '/selected-b';
const startB = await controller.start(ownerB, 'project-b', []);
assert.equal(startB?.watchId, 'watch-2');

const eventA: DirectoryImportEvent = {
  watchId: 'watch-1',
  projectId: 'project-a',
  file: importedFile('import-a'),
};
assert.equal(sessions[0].options.onImported(eventA), true);
assert.equal(ownerA.sent.length, 1);
assert.equal(ownerB.sent.length, 0, 'events must only reach the initiating WebContents');
assert.equal(sessions[0].options.onImported({ ...eventA, projectId: 'project-b' }), false);
assert.equal(ownerA.sent.length, 1, 'project-mismatched events must be suppressed');

await assert.rejects(controller.activate(ownerB, 'watch-1'), /grant is unavailable/);
await assert.rejects(
  controller.acknowledge(ownerB, 'watch-1', 'import-a', 'reserved'),
  /grant is unavailable/,
);
await assert.rejects(controller.stop(ownerB, 'watch-1'), /grant is unavailable/);
await controller.activate(ownerA, 'watch-1');
await controller.acknowledge(ownerA, 'watch-1', 'import-a', 'reserved');
await controller.stop(ownerA, 'watch-1');
assert.equal(sessions[0].options.onImported(eventA), false, 'retirement closes active publication routing');
await controller.acknowledge(ownerA, 'watch-1', 'import-a', 'accepted');
await controller.acknowledge(ownerA, 'watch-1', 'import-a', 'accepted');
assert.equal(sessions[0].activations, 1);
assert.equal(sessions[0].stops, 1, 'retirement closes the OS watcher once');
assert.deepEqual(sessions[0].acknowledgements, [
  { importId: 'import-a', disposition: 'reserved' },
  { importId: 'import-a', disposition: 'accepted' },
  { importId: 'import-a', disposition: 'accepted' },
]);
selected = '/replacement-a';
const replacementA = await controller.start(ownerA, 'project-a', []);
assert.equal(replacementA?.watchId, 'watch-3', 'a retired grant must not block a replacement watch');


ownerA.destroy();
const destructionTurn = Promise.withResolvers<void>();
setImmediate(destructionTurn.resolve);
await destructionTurn.promise;
assert.equal(sessions[0].stops, 1, 'WebContents destruction must close every owned watch');
assert.equal(sessions[0].options.onImported(eventA), false, 'destroyed owners cannot receive events');
assert.equal(sessions[2].stops, 1, 'owner teardown closes the replacement active watcher');

uploadDirectory = '/changed-media';
selected = '/changed-media';
await assert.rejects(
  controller.start(ownerB, 'project-b', []),
  /media destination cannot overlap/,
  'root checks must use the current MEDIA_DIR destination, not a cached path',
);

assert.equal(sessions[1].stops, 1, 'reconfiguration must settle the previous project watch first');

const oldStartEntered = Promise.withResolvers<void>();
const releaseOldStart = Promise.withResolvers<void>();
let reconfiguredSelection = '/old-root';
let reconfiguredId = 0;
const reconfiguredSessions: Array<{
  readonly options: DirectoryWatchSessionOptions;
  stops: number;
}> = [];
const reconfigureController = new DirectoryWatchController({
  selectDirectory: async () => reconfiguredSelection,
  realpath: async (path) => path,
  canonicalUploadDirectory: async () => '/media/uploads',
  randomId: () => `reconfigured-${++reconfiguredId}`,
  createSession: (options) => {
    const state = { options, stops: 0 };
    const isOldRoot = options.root === '/old-root';
    reconfiguredSessions.push(state);
    return {
      watchId: options.watchId,
      projectId: options.projectId,
      start: async () => {
        if (isOldRoot) {
          oldStartEntered.resolve();
          await releaseOldStart.promise;
        }
        return {
          watchId: options.watchId,
          projectId: options.projectId,
          directoryName: isOldRoot ? 'old-root' : 'new-root',
          files: [],
        };
      },
      activate: async () => undefined,
      acknowledge: async () => undefined,
      stop: async () => { state.stops += 1; },
    };
  },
  reportError: () => undefined,
});
const reconfigureOwner = new FakeSender(3);
const staleStart = reconfigureController.start(reconfigureOwner, 'project-reconfigure', []);
await oldStartEntered.promise;
reconfiguredSelection = '/new-root';
const currentStart = await reconfigureController.start(
  reconfigureOwner, 'project-reconfigure', [],
);
assert.equal(currentStart?.directoryName, 'new-root');
releaseOldStart.resolve();
assert.equal(await staleStart, null, 'an old-root completion must not publish a stale start snapshot');
assert.ok(reconfiguredSessions[0].stops >= 1, 'reconfiguration must stop the old generation');
assert.equal(
  reconfiguredSessions[0].options.onImported({
    watchId: 'reconfigured-1',
    projectId: 'project-reconfigure',
    file: importedFile('stale-import'),
  }),
  false,
  'an old generation must not emit after reconfiguration',
);
await reconfigureController.stop(reconfigureOwner, 'reconfigured-2');
process.stdout.write('directory-watch-controller.verify: ownership, routing, and opaque grants passed\n');
