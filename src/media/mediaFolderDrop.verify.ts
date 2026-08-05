import assert from 'node:assert/strict';
import { setEditorDrag, type EditorMediaDragPayload } from '../editor/editorDrag';
import { assetIdsFromFolderDrop } from './folderDrop';
import { setMediaAssetDrag } from './drag';

function fakeDragEvent(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  let effectAllowed = 'none';
  let dropEffect = 'none';
  const dataTransfer = {
    get files() { return { length: 0 } as FileList; },
    get types() { return [...store.keys()]; },
    get effectAllowed() { return effectAllowed; },
    set effectAllowed(value: string) { effectAllowed = value; },
    get dropEffect() { return dropEffect; },
    set dropEffect(value: string) { dropEffect = value; },
    setData(type: string, value: string) { store.set(type, value); },
    getData(type: string) { return store.get(type) ?? ''; },
  };
  return { dataTransfer } as unknown as React.DragEvent;
}

// effectAllowed must accept folder "move" (issue #42 / Chromium drop rejection).
{
  const event = fakeDragEvent();
  setMediaAssetDrag(event, { id: 'a1', kind: 'video', name: 'clip.mp4' }, ['a1', 'a2']);
  assert.equal(event.dataTransfer.effectAllowed, 'copyMove', 'pool drag allows folder move');
  setEditorDrag(event, {
    source: 'media', id: 'a1', name: 'clip.mp4', assetKind: 'video', assetIds: ['a1', 'a2'],
  } satisfies Omit<EditorMediaDragPayload, 'v'>);
  assert.equal(event.dataTransfer.effectAllowed, 'copyMove', 'editor drag allows folder move');
}

// Multi-select drop onto a folder moves every selected id.
{
  const event = fakeDragEvent();
  setEditorDrag(event, {
    source: 'media', id: 'a1', name: 'clip.mp4', assetKind: 'video', assetIds: ['a1', 'a2', 'a3'],
  });
  setMediaAssetDrag(event, { id: 'a1', kind: 'video', name: 'clip.mp4' }, ['a1', 'a2', 'a3']);
  assert.deepEqual(assetIdsFromFolderDrop(event), ['a1', 'a2', 'a3']);
}

// Single-id media mime still works.
{
  const event = fakeDragEvent({
    'application/x-openchatcut-media-asset': JSON.stringify({ v: 1, assetId: 'solo' }),
  });
  assert.deepEqual(assetIdsFromFolderDrop(event), ['solo']);
}

console.log('mediaFolderDrop.verify: copyMove + multi-id folder drop ok');
