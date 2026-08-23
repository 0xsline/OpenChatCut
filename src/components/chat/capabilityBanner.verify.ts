// Verify: capability-gap banner derivation — only creative caps count,
// and each returned key carries a display label so the banner can render.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CAPABILITY_LABELS, formatCapabilityNames, missingCreativeCaps } from './capabilityBanner.ts';
import { applyLiveCaps } from '../../agent/capabilities';
import type { ChatPanelController } from './chatPanelController.ts';
import { CapabilityBanner } from './ChatPanelView.tsx';

// No capability enabled → every creative capability is missing.
applyLiveCaps({});
const allMissing = missingCreativeCaps();
assert.deepEqual(allMissing, ['transcription', 'image', 'voice', 'video', 'music', 'sound']);
for (const key of allMissing) {
  assert.ok(CAPABILITY_LABELS[key], `label for ${key}`);
}
assert.equal(formatCapabilityNames(['A', 'B'], 'zh'), 'A、B');
assert.equal(formatCapabilityNames(['A', 'B'], 'ru'), 'A и B');

// Every creative capability enabled → banner hides.
applyLiveCaps({ transcription: true, image: true, voice: true, video: true, music: true, sound: true });
assert.deepEqual(missingCreativeCaps(), [], 'configured creative caps hide the banner');
const configuredController = {
  props: { onOpenSettings: () => undefined },
  t: (key: string) => key,
} as unknown as ChatPanelController;
assert.equal(
  renderToStaticMarkup(createElement(CapabilityBanner, { controller: configuredController })),
  '',
  'configured creative caps must suppress the rendered banner',
);

// Partial: only transcription off → exactly that key surfaces.
applyLiveCaps({ image: true, voice: true, video: true, music: true, sound: true });
assert.deepEqual(missingCreativeCaps(), ['transcription']);

console.log('capabilityBanner.verify: creative-cap derivation and labels OK');
