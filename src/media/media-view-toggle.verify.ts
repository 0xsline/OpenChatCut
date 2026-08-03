import assert from 'node:assert/strict';
import { mediaViewToggleLabel, toggleMediaView } from './mediaView';

assert.equal(mediaViewToggleLabel('list'), '切换至网格视图');
assert.equal(toggleMediaView('list'), 'grid');
assert.equal(mediaViewToggleLabel('grid'), '切换至列表视图');
assert.equal(toggleMediaView('grid'), 'list');

console.log('media view toggle verification passed');
