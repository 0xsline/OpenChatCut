import assert from 'node:assert/strict';
import { parseLibraryDrag, setLibraryDrag } from '../library/drag';
import {
  EDITOR_DRAG_MIME,
  hasEditorDrag,
  mediaAssetIds,
  parseEditorDrag,
  setEditorDrag,
} from './editorDrag';

class FakeDataTransfer {
  private readonly values = new Map<string, string>();
  effectAllowed = 'uninitialized';
  get types(): string[] { return [...this.values.keys()]; }
  setData(type: string, value: string): void { this.values.set(type, value); }
  getData(type: string): string { return this.values.get(type) ?? ''; }
}

const media = new FakeDataTransfer();
setEditorDrag({ dataTransfer: media } as unknown as React.DragEvent, {
  source: 'media', id: 'asset-1', assetIds: ['asset-1', 'asset-2', 'asset-1'],
  name: 'Interview.mp4', assetKind: 'video',
});
assert.equal(hasEditorDrag({ dataTransfer: media } as unknown as React.DragEvent), true);
const mediaPayload = parseEditorDrag({ dataTransfer: media } as unknown as React.DragEvent);
assert.ok(mediaPayload?.source === 'media');
assert.deepEqual(mediaAssetIds(mediaPayload), ['asset-1', 'asset-2']);

const library = new FakeDataTransfer();
setLibraryDrag({ dataTransfer: library } as unknown as React.DragEvent, {
  kind: 'fx', id: 'fx-1', name: 'Film Grain',
});
assert.equal(parseLibraryDrag({ dataTransfer: library } as unknown as React.DragEvent)?.id, 'fx-1');
assert.deepEqual(
  parseEditorDrag({ dataTransfer: library } as unknown as React.DragEvent),
  { v: 1, source: 'library', id: 'fx-1', name: 'Film Grain', resourceKind: 'fx' },
);

const invalid = new FakeDataTransfer();
invalid.setData(EDITOR_DRAG_MIME, '{"v":1,"source":"media","id":"","name":"x","assetKind":"video"}');
assert.equal(parseEditorDrag({ dataTransfer: invalid } as unknown as React.DragEvent), null);

console.log('editorDrag.verify: unified drag payload OK');
