import assert from 'node:assert/strict';
import type { AgentContext } from '../context.ts';
import {
  activeEditorState,
  activeTimeline,
  type ProjectDoc,
  type TimelineState,
} from '../../editor/types.ts';
import type { EditorCommands } from '../../editor/store.ts';
import { execMulticamTool } from './multicam-tools.ts';

type ToolResult = Record<string, unknown>;
type LiveEditor = {
  doc: ProjectDoc;
  projectId: string;
  applyStateCalls: number;
  appliedState: TimelineState | null;
};

const alignedSamples = (() => {
  const samples = new Float32Array(2_000);
  let seed = 0x1234_5678;
  for (let index = 0; index < samples.length; index += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    samples[index] = (seed / 0xffff_ffff) * 2 - 1;
  }
  return samples;
})();

const decodedAudio = {
  numberOfChannels: 1,
  length: alignedSamples.length,
  sampleRate: 4_000,
  getChannelData: () => alignedSamples,
} as unknown as AudioBuffer;

function projectDoc(): ProjectDoc {
  return {
    version: 3,
    assets: [
      {
        id: 'asset_reference',
        name: 'Reference',
        kind: 'video',
        src: '/media/uploads/reference.mp4',
        sourceRevision: 'source-reference-v1',
        durationInFrames: 300,
      },
      {
        id: 'asset_follower',
        name: 'Follower',
        kind: 'video',
        src: '/media/uploads/follower.mp4',
        sourceRevision: 'source-follower-v1',
        durationInFrames: 300,
      },
    ],
    mediaFolders: [],
    activeTimelineId: 'timeline_main',
    timelines: [
      {
        id: 'timeline_main',
        name: 'Main',
        order: 0,
        fps: 30,
        width: 1920,
        height: 1080,
        selectedId: null,
        trackOrder: ['track_reference', 'track_follower'],
        tracks: {
          track_reference: { kind: 'video' },
          track_follower: { kind: 'video' },
        },
        items: [
          {
            id: 'item_reference',
            track: 'track_reference',
            startFrame: 0,
            durationInFrames: 300,
            name: 'Reference',
            kind: 'video',
            src: '/media/uploads/reference.mp4',
            sourceRevision: 'source-reference-v1',
          },
          {
            id: 'item_follower',
            track: 'track_follower',
            startFrame: 90,
            durationInFrames: 300,
            name: 'Follower',
            kind: 'video',
            src: '/media/uploads/follower.mp4',
            sourceRevision: 'source-follower-v1',
          },
        ],
      },
      {
        id: 'timeline_alt',
        name: 'Alternate',
        order: 1,
        fps: 30,
        width: 1920,
        height: 1080,
        selectedId: null,
        items: [],
      },
    ],
  };
}

function pauseFirstDecode(): { started: Promise<void>; release: () => void } {
  let signalStarted!: () => void;
  let releaseDecode!: (buffer: AudioBuffer) => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const paused = new Promise<AudioBuffer>((resolve) => { releaseDecode = resolve; });
  let decodeCount = 0;

  class DeferredOfflineAudioContext {
    constructor(_channels: number, _length: number, _sampleRate: number) {}

    decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
      decodeCount += 1;
      if (decodeCount === 1) {
        signalStarted();
        return paused;
      }
      return Promise.resolve(decodedAudio);
    }
  }

  Object.defineProperty(globalThis, 'OfflineAudioContext', {
    configurable: true,
    writable: true,
    value: DeferredOfflineAudioContext,
  });
  return { started, release: () => releaseDecode(decodedAudio) };
}

async function runDeferredSync(
  mutate?: (live: LiveEditor) => void,
): Promise<{ live: LiveEditor; result: ToolResult }> {
  const live: LiveEditor = {
    doc: projectDoc(),
    projectId: 'project-a',
    applyStateCalls: 0,
    appliedState: null,
  };
  const commands = {
    applyState: (nextState: TimelineState) => {
      live.applyStateCalls += 1;
      live.appliedState = nextState;
      live.doc = {
        ...live.doc,
        timelines: live.doc.timelines.map((timeline) => timeline.id === live.doc.activeTimelineId
          ? { ...timeline, ...nextState, id: timeline.id, name: timeline.name, order: timeline.order }
          : timeline),
      };
    },
  } as EditorCommands;
  const ctx = {
    commands,
    getState: () => activeEditorState(live.doc),
    getDoc: () => live.doc,
    getProjectId: () => live.projectId,
    getCreativeMode: () => null,
    templates: [],
    audio: [],
  } satisfies AgentContext;

  const decode = pauseFirstDecode();
  const pending = execMulticamTool('multicam_sync', {
    itemIds: ['item_reference', 'item_follower'],
    referenceItemId: 'item_reference',
    masterItemId: 'item_reference',
  }, ctx) as Promise<ToolResult>;
  await decode.started;
  mutate?.(live);
  decode.release();
  return { live, result: await pending };
}

function assertRetryableStale(live: LiveEditor, result: ToolResult): void {
  assert.equal(result.ok, false);
  assert.equal(result.code, 'stale');
  assert.equal(result.status, 'stale');
  assert.equal(result.stale, true);
  assert.equal(result.retryable, true);
  assert.equal(result.changed, false);
  assert.equal(live.applyStateCalls, 0, 'stale completion must not call applyState');
  assert.match(String(result.message), /retry/i);
}

const originalFetch = globalThis.fetch;
const originalOfflineAudioContext = Object.getOwnPropertyDescriptor(globalThis, 'OfflineAudioContext');
try {
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3, 4]))) as typeof fetch;

  const edited = await runDeferredSync((live) => {
    activeTimeline(live.doc).items[1]!.startFrame = 123;
  });
  assertRetryableStale(edited.live, edited.result);
  assert.equal(activeTimeline(edited.live.doc).items[1]?.startFrame, 123, 'waiting edit must survive');

  const locked = await runDeferredSync((live) => {
    activeTimeline(live.doc).tracks!.track_follower!.locked = true;
  });
  assertRetryableStale(locked.live, locked.result);
  assert.equal(activeTimeline(locked.live.doc).tracks?.track_follower?.locked, true, 'waiting lock must survive');

  const relinked = await runDeferredSync((live) => {
    live.doc.assets[1]!.src = '/media/uploads/follower-relinked.mp4';
    live.doc.assets[1]!.sourceRevision = 'source-follower-v2';
    activeTimeline(live.doc).items[1]!.src = '/media/uploads/follower-relinked.mp4';
    activeTimeline(live.doc).items[1]!.sourceRevision = 'source-follower-v2';
  });
  assertRetryableStale(relinked.live, relinked.result);
  assert.equal(relinked.live.doc.assets[1]?.sourceRevision, 'source-follower-v2', 'waiting relink must survive');
  assert.equal(activeTimeline(relinked.live.doc).items[1]?.sourceRevision, 'source-follower-v2');

  const switchedProject = await runDeferredSync((live) => {
    live.projectId = 'project-b';
    live.doc = projectDoc();
  });
  assertRetryableStale(switchedProject.live, switchedProject.result);
  assert.equal(switchedProject.result.reason, 'project_changed');
  assert.equal(switchedProject.result.currentProjectId, 'project-b');

  const switchedTimeline = await runDeferredSync((live) => {
    live.doc.activeTimelineId = 'timeline_alt';
  });
  assertRetryableStale(switchedTimeline.live, switchedTimeline.result);
  assert.equal(switchedTimeline.result.reason, 'timeline_changed');
  assert.equal(switchedTimeline.live.doc.activeTimelineId, 'timeline_alt');

  const unchanged = await runDeferredSync();
  assert.equal(unchanged.result.ok, true, 'unchanged completion must succeed');
  assert.equal(unchanged.result.changed, true);
  assert.equal(unchanged.live.applyStateCalls, 1, 'unchanged completion must apply exactly once');
  assert(unchanged.live.appliedState);
  assert.equal(unchanged.live.appliedState.items[1]?.startFrame, 0);
  assert.equal(typeof unchanged.result.groupId, 'string');
  assert.deepEqual(unchanged.result.methods, ['audio']);
} finally {
  globalThis.fetch = originalFetch;
  if (originalOfflineAudioContext) {
    Object.defineProperty(globalThis, 'OfflineAudioContext', originalOfflineAudioContext);
  } else {
    Reflect.deleteProperty(globalThis, 'OfflineAudioContext');
  }
}

console.log('multicam tool async stale guard checks passed');
