import assert from 'node:assert/strict';
import { resolveAgentReferences, type AgentContext } from '../../agent/context';
import type { MediaAsset } from '../../editor/types';
import {
  editorDragReference,
  editorDragReferences,
} from './editorDragReference';

const assets = [
  { id: 'asset-1', name: 'Interview.mp4', kind: 'video' },
  { id: 'asset-2', name: 'Overlay.png', kind: 'image' },
  { id: 'asset-3', name: 'Voiceover.mp3', kind: 'audio' },
] satisfies Pick<MediaAsset, 'id' | 'name' | 'kind'>[];

assert.deepEqual(
  editorDragReferences({
    v: 1,
    source: 'media',
    id: 'asset-1',
    assetIds: ['asset-1', 'asset-2', 'asset-3'],
    name: 'Interview.mp4',
    assetKind: 'video',
  }, assets),
  assets,
  'a selected media drag must attach every selected asset with its live name and kind',
);

assert.deepEqual(
  editorDragReference({
    v: 1,
    source: 'library',
    id: 'template-1',
    name: 'Quote Card',
    resourceKind: 'template',
  }),
  { id: 'template-1', name: 'Quote Card', kind: 'template' },
);

const libraryReference = editorDragReference({
  v: 1,
  source: 'library',
  id: 'zoom-1',
  name: 'Slow Push',
  resourceKind: 'zoom',
});
assert.deepEqual(libraryReference, {
  id: 'library:zoom:zoom-1',
  name: 'Slow Push',
  kind: 'library-resource',
  resourceId: 'zoom-1',
  resourceKind: 'zoom',
});
assert.deepEqual(
  resolveAgentReferences({
    getDoc: () => ({ assets: [] }),
    templates: [],
  } as unknown as AgentContext, [libraryReference]),
  [{ type: 'library_resource', id: 'zoom-1', name: 'Slow Push', kind: 'zoom' }],
);

console.log('editorDragReference.verify: structured composer references OK');
