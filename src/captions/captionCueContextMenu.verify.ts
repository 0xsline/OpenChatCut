import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./CaptionTrackLane.tsx', import.meta.url), 'utf8');

assert.match(source, /role="menu"/, 'caption cue context actions should use menu semantics');
assert.match(source, /createCaptionTimelineClipboard/, 'copy should capture structured cue timing, not only DOM text');
assert.match(source, /appendCaptionClipboardToTrack/, 'paste should materialize copied cues at the playhead');
assert.match(source, /captionContextMenuIntent\(event\.ctrlKey\)/, 'macOS Ctrl+click should not open a menu after toggling selection');
assert.match(source, /onSeedChat\?/, 'caption context menu should support explicit AI handoff when the parent provides it');
assert.doesNotMatch(source, /navigator\.clipboard\.readText\(/, 'timeline paste must not replace cue text from an unstructured clipboard read');

console.log('captionCueContextMenu.verify: cue context-menu integration contract OK');
