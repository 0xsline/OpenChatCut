import assert from 'node:assert/strict';

const modulePath = './captionTimelineClipboard';
const {
  createCaptionTimelineClipboard,
  createCaptionTrackFromClipboard,
  createTranslatedCaptionTrack,
  appendCaptionClipboardToTrack,
} = await import(modulePath).catch(() => {
  assert.fail('caption timeline clipboard must have a caption-owned data layer');
});

const clipboard = createCaptionTimelineClipboard([
  { text: ' First ', start: 1_000, end: 2_400 },
  { text: 'Second', start: 3_100, end: 4_000 },
]);
assert.deepEqual(clipboard?.cues, [
  { text: 'First', start: 1_000, end: 2_400 },
  { text: 'Second', start: 3_100, end: 4_000 },
]);

const pasted = createCaptionTrackFromClipboard(clipboard, 6_000);
assert.deepEqual(pasted?.sourceEntries?.[0]?.words, [
  { text: 'First', start: 6_000, end: 7_400 },
  { text: 'Second', start: 8_100, end: 9_000 },
], 'paste should anchor the first cue at the playhead and preserve relative gaps');

assert.deepEqual(createTranslatedCaptionTrack('Translated', 1_000, 2_400)?.sourceEntries?.[0]?.words, [
  { text: 'Translated', start: 1_000, end: 2_400 },
]);
assert.equal(createCaptionTimelineClipboard([]), null);
assert.equal(createTranslatedCaptionTrack('   ', 1_000, 2_400), null);

const existing = createTranslatedCaptionTrack('Existing', 500, 900)!;
const appended = appendCaptionClipboardToTrack(existing, [], clipboard, 10_000);
assert.deepEqual(appended?.sourceEntries?.[0]?.words, [
  { text: 'Existing', start: 500, end: 900 },
  { text: 'First', start: 10_000, end: 11_400 },
  { text: 'Second', start: 12_100, end: 13_000 },
], 'a caption lane without parent timeline wiring should still paste structured cues into its current track');

console.log('captionTimelineClipboard.verify: structured caption copy/paste rules OK');
