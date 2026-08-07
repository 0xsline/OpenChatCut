import assert from 'node:assert/strict';
import { activeTimeline, captionsOnTrack, defaultTrackId } from '../editor/types';
import { runProjectMigrations } from '../persist/migrations';
import { newTranscriptGeneration } from '../transcript/identity';
import { resolveEntryWordRefs } from './resolve';
import { matchEntries } from '../agent/tools/captions-lanes';

const legacyV4 = {
  version: 4,
  assets: [],
  mediaFolders: [],
  timelines: [{
    id: 'timeline-caption-identity',
    name: 'Caption identity',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['C1', 'A1'],
    tracks: {
      C1: {
        kind: 'caption',
        captions: {
          enabled: true,
          template: 'plain',
          pacing: 'phrase',
          perSource: { duplicate: { maxLines: 1 } },
          sourceEntries: [
            { id: 'duplicate', itemId: 'audio-source', trackOrder: 1 },
            {
              id: 'duplicate', itemId: 'manual:imported', trackOrder: 0,
              words: [{ text: 'Imported manual cue', start: 100, end: 500 }],
            },
          ],
        },
      },
      A1: { kind: 'audio' },
    },
    items: [{
      id: 'audio-source', track: 'A1', startFrame: 0, durationInFrames: 90,
      kind: 'audio', name: 'Source', src: '/source.wav',
      transcript: [{ text: 'source', start: 0, end: 400 }],
    }],
  }],
  activeTimelineId: 'timeline-caption-identity',
};

const first = runProjectMigrations(JSON.parse(JSON.stringify(legacyV4)))!.doc;
const second = runProjectMigrations(JSON.parse(JSON.stringify(legacyV4)))!.doc;
assert.deepEqual(first, second, 'v4 identity backfill is deterministic for copied/imported documents');
const timeline = activeTimeline(first);
const item = timeline.items[0]!;
assert.ok(item.transcriptGenerationId);
assert.ok(item.transcript?.[0]?.id);
const captions = captionsOnTrack(timeline, defaultTrackId(timeline, 'caption')!)!;
const sourceIds = captions.sourceEntries!.map((entry) => entry.id);
assert.equal(new Set(sourceIds).size, sourceIds.length, 'duplicate imported source ids are deterministically disambiguated');
assert.ok(captions.sourceEntries!.find((entry) => entry.words)?.words?.[0]?.id, 'legacy manual cues receive persistent ids');
assert.equal(captions.perSource?.[sourceIds[0]!]?.maxLines, 1, 'source-specific layout data survives identity repair');

assert.deepEqual(
  matchEntries(captions.sourceEntries!, { sourceId: sourceIds[1], index: 0, itemId: 'stale-item' }, timeline),
  [1],
  'persisted source identity wins over stale legacy index/item selectors',
);
const legacyMatch = matchEntries(captions.sourceEntries!, { index: 0 }, timeline);
assert.match(
  'error' in legacyMatch ? legacyMatch.error : '',
  /legacy-only/,
  'legacy index fallback is rejected once a source has stable identity',
);
const automaticEntry = captions.sourceEntries!.find((entry) => entry.itemId === item.id)!;
const oldRef = resolveEntryWordRefs(automaticEntry, timeline.items, timeline.fps)[0]!;
const replacement = { ...item, ...newTranscriptGeneration([{ text: 'source', start: 0, end: 400 }]) };
const newRef = resolveEntryWordRefs(automaticEntry, [replacement], timeline.fps)[0]!;
assert.notEqual(replacement.transcriptGenerationId, item.transcriptGenerationId, 'retranscription always creates a new generation');
assert.notEqual(newRef, oldRef, 'old word references fail closed instead of retargeting same-index replacement words');

console.log('captionIdentity.verify: persisted caption/transcript identities remain stable');
