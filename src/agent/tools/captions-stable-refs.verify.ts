import assert from 'node:assert/strict';
import type { AgentContext } from '../context';
import type { CaptionsData } from '../../captions/types';
import { paginate } from '../../captions/types';
import {
  applyWordOverrides,
  resolveCaptionWordIndices,
  resolveCaptionWordRefs,
  resolveCaptionWords,
} from '../../captions/resolve';
import type { TimelineItem, TimelineState } from '../../editor/types';
import { execCaptionsTool } from './captions-tools';
import { applyDisplayTextEntries } from './captions-word-overrides';

const item = (id: string, text: string, startFrame = 0): TimelineItem => ({
  id,
  track: `track_${id}`,
  startFrame,
  durationInFrames: 90,
  kind: 'audio',
  name: `${text}.wav`,
  src: `/media/${text}.wav`,
  transcriptGenerationId: `generation-${id}`,
  transcript: text === 'alpha'
    ? [{ id: 'alpha-word', text: 'alpha', start: 0, end: 300 }, { id: 'beta-word', text: 'beta', start: 400, end: 700 }]
    : [{ id: 'gamma-word', text: 'gamma', start: 0, end: 300 }],
});

const captions: CaptionsData = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  sources: ['a', 'b'],
};
const items = [item('a', 'alpha'), item('b', 'gamma')];
const initialWords = resolveCaptionWords(captions, items, 30);
const initialRefs = resolveCaptionWordRefs(captions, items, 30);
const pagedRefs = paginate(initialWords, 'phrase', 1)
  .flatMap((page) => page.words.map((word) => initialRefs[initialWords.indexOf(word)]));
assert.deepEqual(pagedRefs, initialRefs, 'pagination does not rewrite word identity');
const betaPosition = initialWords.findIndex((word) => word.text === 'beta');
const betaRef = initialRefs[betaPosition]!;
assert.ok(betaRef.startsWith('cw2.'), 'refs are opaque versioned identities');

const reordered: CaptionsData = { ...captions, sources: ['b', 'a'] };
const reorderedWords = resolveCaptionWords(reordered, items, 30);
const reorderedRefs = resolveCaptionWordRefs(reordered, items, 30);
assert.equal(reorderedRefs[reorderedWords.findIndex((word) => word.text === 'beta')], betaRef);
assert.notDeepEqual(reorderedRefs, initialRefs, 'source merge order can change without changing word identity');

const retimedItems = [items[0]!, { ...items[1]!, startFrame: 30 }];
const retimedWords = resolveCaptionWords(captions, retimedItems, 30);
const retimedRefs = resolveCaptionWordRefs(captions, retimedItems, 30);

const manual: CaptionsData = {
  enabled: true,
  template: 'plain',
  pacing: 'phrase',
  sourceEntries: [{
    id: 'manual_lane',
    itemId: 'manual:manual_lane',
    words: [{ id: 'manual-first', text: 'first', start: 0, end: 200 }, { id: 'manual-second', text: 'second', start: 300, end: 500 }],
  }],
};
const manualRefs = resolveCaptionWordRefs(manual, [], 30);
const retimedManual = {
  ...manual,
  sourceEntries: [{
    ...manual.sourceEntries![0]!,
    words: [{ id: 'manual-first', text: 'first', start: 600, end: 800 }, { id: 'manual-second', text: 'second', start: 100, end: 300 }],
  }],
};
const retimedManualWords = resolveCaptionWords(retimedManual, [], 30);
const retimedManualRefs = resolveCaptionWordRefs(retimedManual, [], 30);
assert.equal(
  retimedManualRefs[retimedManualWords.findIndex((word) => word.text === 'first')],
  manualRefs[0],
  'manual lane refs use persistent cue identities',
);
assert.equal(retimedRefs[retimedWords.findIndex((word) => word.text === 'beta')], betaRef);

const hiddenResult = applyDisplayTextEntries(
  [{ wordRef: betaRef, hidden: true }],
  captions,
  items,
  30,
);
const hiddenApplied = applyWordOverrides(
  initialWords,
  resolveCaptionWordIndices(captions, items, 30),
  hiddenResult.wordOverrides,
  initialRefs,
);
assert.ok(!hiddenApplied.wordRefs.includes(betaRef), 'hidden words leave the resolved stable identity unchanged');
assert.equal(resolveCaptionWordRefs(captions, items, 30)[betaPosition], betaRef);

let state: TimelineState = {
  fps: 30,
  width: 1920,
  height: 1080,
  selectedId: null,
  trackOrder: ['track_a', 'track_b'],
  tracks: { track_a: { kind: 'audio' }, track_b: { kind: 'audio' } },
  items,
  captions,
};
const ctx = {
  commands: {
    updateCaptions: (patch: Partial<CaptionsData>) => {
      state = { ...state, captions: { ...state.captions!, ...patch } };
    },
  },
  getState: () => state,
  getDoc: () => ({}),
  getCreativeMode: () => null,
  templates: [],
  audio: [],
} as unknown as AgentContext;
const read = await execCaptionsTool('read_captions', {}, ctx) as {
  pages: Array<{ words: Array<{ index: number; wordRef: string; text: string }> }>;
};
const readBeta = read.pages.flatMap((page) => page.words).find((word) => word.text === 'beta')!;
assert.equal(readBeta.wordRef, betaRef);
const edit = await execCaptionsTool('edit_captions', {
  action: 'display_text',
  json: { overrides: [{ wordRef: readBeta.wordRef, text: 'BETA' }] },
}, ctx) as { ok: boolean; errors?: string[] };
assert.equal(edit.ok, true, edit.errors?.join(', '));
const stored = state.captions!.wordOverrides!;
assert.equal(Object.values(stored)[0]?.wordRef, betaRef, 'new writes persist stable metadata');

const appliedAfterReorder = applyWordOverrides(
  reorderedWords,
  resolveCaptionWordIndices(reordered, items, 30),
  stored,
  reorderedRefs,
);
assert.equal(appliedAfterReorder.words.find((word) => word.text === 'BETA')?.text, 'BETA');
assert.equal(
  appliedAfterReorder.wordRefs[appliedAfterReorder.words.findIndex((word) => word.text === 'BETA')],
  betaRef,
  'the override follows its source word after regrouping',
);
const appliedAfterRetiming = applyWordOverrides(
  retimedWords,
  resolveCaptionWordIndices(captions, retimedItems, 30),
  stored,
  retimedRefs,
);
assert.equal(
  appliedAfterRetiming.words.find((word) => word.text === 'BETA')?.text,
  'BETA',
  'timing edits do not detach a stored stable override',
);

const clearedByIndex = await execCaptionsTool('edit_captions', {
  action: 'display_text',
  json: { overrides: [{ wordIndex: readBeta.index, clear: true }] },
}, ctx) as { ok: boolean };
assert.equal(clearedByIndex.ok, true);
assert.equal(Object.keys(state.captions!.wordOverrides ?? {}).length, 0);
await execCaptionsTool('edit_captions', {
  action: 'display_text',
  json: { overrides: [{ wordIndex: readBeta.index, text: 'numeric selector' }] },
}, ctx);
assert.equal(
  Object.values(state.captions!.wordOverrides ?? {})[0]?.wordRef,
  betaRef,
  'legacy numeric writes attach the current stable ref',
);
const clearedByRef = await execCaptionsTool('edit_captions', {
  action: 'display_text',
  json: { overrides: [{ wordRef: betaRef, clear: true }] },
}, ctx) as { ok: boolean };
assert.equal(clearedByRef.ok, true);
assert.equal(Object.keys(state.captions!.wordOverrides ?? {}).length, 0);

const duplicateSources = { ...captions, sources: ['a', 'a'] };
const duplicateRef = resolveCaptionWordRefs(duplicateSources, items, 30)[0]!;
const ambiguous = applyDisplayTextEntries(
  [{ wordRef: duplicateRef, text: 'bad' }],
  duplicateSources,
  items,
  30,
);
assert.match(ambiguous.errors[0]!, /ambiguous wordRef/);

const legacy = applyWordOverrides(initialWords, resolveCaptionWordIndices(captions, items, 30), { 0: { text: 'legacy' } }, initialRefs);
assert.equal(legacy.words[0]?.text, 'legacy', 'old numeric-only ProjectDoc overrides still render');

const stale = await execCaptionsTool('edit_captions', {
  action: 'display_text',
  json: { overrides: [{ wordRef: 'cw1.stale.999', text: 'bad' }] },
}, ctx) as { ok: boolean; errors: string[] };
assert.equal(stale.ok, false);
assert.match(stale.errors[0]!, /unknown or stale wordRef/);

console.log('captions stable refs check passed');
