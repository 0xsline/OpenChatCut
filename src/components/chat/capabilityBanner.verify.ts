// Verify: capability-gap banner derivation — only creative caps count,
// and each returned key carries a display label so the banner can render.
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CAPABILITY_LABELS,
  formatCapabilityNames,
  missingCreativeCaps,
  transcriptionAvailability,
} from './capabilityBanner.ts';
import { applyLiveCaps } from '../../agent/capabilities';
import type { ChatPanelController } from './chatPanelController.ts';
import { CapabilityBanner, CapabilityBannerView } from './CapabilityGapBanner.tsx';

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
assert.deepEqual(missingCreativeCaps(undefined, 'ready'), [], 'configured creative caps hide the banner');
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

// Free local Whisper: a tier ready for either engine means transcription IS
// available, so it must leave the warning; a missing tier is a free download
// prompt, never a "not configured" / purchase claim.
applyLiveCaps({});
const transcriptionGap = ['image', 'voice', 'video', 'music', 'sound'];
assert.equal(transcriptionAvailability([{ modelId: 'Xenova/whisper-small', ggmlDownloaded: true }]), 'ready',
  'the whisper.cpp companion alone is enough for the desktop engine');
assert.equal(transcriptionAvailability([{ modelId: 'Xenova/whisper-small', onnxDownloaded: true, ggmlDownloaded: false }]), 'ready',
  'the ONNX export alone is enough for the browser engine');
assert.equal(transcriptionAvailability([{ modelId: 'Xenova/whisper-small', onnxDownloaded: false, ggmlDownloaded: false }]), 'missing');
assert.equal(transcriptionAvailability(null), 'unknown', 'an unreadable catalog stays unknown');
assert.deepEqual(missingCreativeCaps(undefined, 'ready'), transcriptionGap);
assert.deepEqual(missingCreativeCaps(undefined, 'missing'), transcriptionGap,
  'the download prompt replaces the unavailable claim');
assert.deepEqual(missingCreativeCaps(undefined, 'unknown'), allMissing);

const freeDownload = renderToStaticMarkup(createElement(CapabilityBannerView, {
  t: (key: string) => key,
  missing: [],
  needsLocalModel: true,
  onOpenSettings: () => undefined,
}));
assert.ok(freeDownload.includes('本地转写模型尚未下载：它免费、可离线使用，无需 API Key。'), 'free local path is explained');
assert.ok(freeDownload.includes('去下载模型'), 'the free next step is a download action');
assert.ok(!freeDownload.includes('以下能力未配置'), 'a missing local model is never reported as unconfigured');

console.log('capabilityBanner.verify: creative-cap derivation and labels OK');
