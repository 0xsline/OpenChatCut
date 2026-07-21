import assert from 'node:assert/strict';
import type { DesignStyle } from '../editor/types';
import {
  loadOwnedStyles,
  resetProjectStoreMemory,
  saveOwnedStyle,
  updateOwnedStyle,
} from './projectStore';
import { kvSet } from './sharedKv';

const editorial: DesignStyle = {
  colors: [{ role: 'primary', value: '#111111' }],
  fonts: [{ role: 'heading', family: 'Inter' }],
  styleGuide: 'Editorial and restrained.',
};
const energetic: DesignStyle = {
  colors: [{ role: 'accent', value: '#ff5500' }],
  fonts: [],
};

resetProjectStoreMemory();

// Entries written by older versions have no metadata and must remain readable.
await kvSet('design-styles:owned', [{ id: 'legacy', name: 'Legacy', style: editorial }]);
assert.deepEqual(await loadOwnedStyles(), [{ id: 'legacy', name: 'Legacy', style: editorial }]);

resetProjectStoreMemory();
const podcast = await saveOwnedStyle('Podcast', editorial, {
  scenarios: [' podcast ', 'education', 'podcast'],
  thumbnailUrl: ' https://example.com/podcast.jpg ',
});
const product = await saveOwnedStyle('Product', energetic);

assert.deepEqual(podcast.scenarios, ['podcast', 'education'], 'scenario tags are normalized and deduplicated');
assert.equal(podcast.thumbnailUrl, 'https://example.com/podcast.jpg');

const renamed = await updateOwnedStyle(podcast.id, { name: product.name });
assert.equal(renamed?.name, 'Product (2)', 'rename collisions get a stable numeric suffix');

const recategorized = await updateOwnedStyle(podcast.id, { scenarios: ['social', ' product ', 'social'] });
assert.deepEqual(recategorized?.scenarios, ['social', 'product']);

const beforeClear = recategorized?.style;
const cleared = await updateOwnedStyle(podcast.id, { thumbnailUrl: null });
assert.equal(cleared?.thumbnailUrl, undefined, 'thumbnail can be cleared independently');
assert.deepEqual(cleared?.style, beforeClear, 'clearing the thumbnail does not change the style body');

const loaded = await loadOwnedStyles();
assert.equal(loaded.length, 2, 'metadata updates persist without removing other styles');
assert.deepEqual(loaded.find((style) => style.id === podcast.id), cleared);
assert.equal(await updateOwnedStyle('missing', { name: 'Nothing' }), undefined);

console.log('design style metadata checks passed');
