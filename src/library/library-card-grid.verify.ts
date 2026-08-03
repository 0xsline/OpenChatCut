import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const modulePath = new URL('./libraryCardGrid.ts', import.meta.url);

let metrics: Record<string, number> | undefined;
try {
  const module = await import(modulePath.href);
  metrics = module.LIBRARY_CARD_GRID_METRICS as Record<string, number> | undefined;
} catch {
  // The first TDD run intentionally reaches this branch before the helper exists.
}

assert.deepEqual(metrics, {
  cardWidth: 120,
  rowHeight: 98,
  columnGap: 10,
  rowGap: 10,
  overscanRows: 1,
});

for (const file of ['./ResourceBrowser.tsx', './TemplateBrowser.tsx']) {
  const source = await readFile(new URL(file, import.meta.url), 'utf8');
  assert.match(source, /LIBRARY_CARD_GRID_METRICS/, `${file} should reuse the shared virtual-grid metrics`);
}

console.log('library-card-grid.verify: shared virtual-grid metrics are stable');
