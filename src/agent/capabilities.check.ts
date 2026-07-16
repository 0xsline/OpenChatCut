// capabilities.check.ts — on/off partition, fallback wiring, and the tsx-safe
// (no vite define) fallback of the configured-capabilities manifest.
//   npx tsx src/agent/capabilities.check.ts
import assert from 'node:assert/strict';
import { capabilitiesPrompt, CONFIGURED_CAPS, type CapabilityKey } from './capabilities';

const ALL_OFF: Record<CapabilityKey, boolean> = {
  image: false, voice: false, video: false, music: false, sound: false,
  stock: false, transcription: false, sandbox: false, web: false,
};

// ── all-off: every gated tool listed as 未配置, none marked available ──
const off = capabilitiesPrompt(ALL_OFF);
assert.ok(off.includes('submit_image') && off.includes('submit_voice') && off.includes('run_code'), 'lists gated tools');
assert.ok(off.includes('（无 key 类能力）'), 'no capability marked available when all off');
assert.ok(off.includes('push_asset'), 'includes a fallback hint for an off capability');

// ── mixed: image + transcription on → they sit in the ✅ section, voice in the ⬜ section ──
const mixed = capabilitiesPrompt({ ...ALL_OFF, image: true, transcription: true });
const onIdx = mixed.indexOf('✅');
const offIdx = mixed.indexOf('⬜');
assert.ok(onIdx >= 0 && offIdx > onIdx, 'both sections present, ✅ before ⬜');
const onLine = mixed.slice(onIdx, offIdx);
assert.ok(onLine.includes('submit_image') && onLine.includes('transcribe_track'), 'configured caps in ✅ section');
assert.ok(!onLine.includes('submit_voice'), 'unconfigured cap NOT in ✅ section');
assert.ok(mixed.slice(offIdx).includes('submit_voice'), 'unconfigured cap in ⬜ section');

// ── tsx (no vite define): CONFIGURED_CAPS falls back to all-false without throwing ──
assert.equal(typeof CONFIGURED_CAPS.image, 'boolean', 'CONFIGURED_CAPS resolves under tsx (all-false fallback, no ReferenceError)');
assert.equal(CONFIGURED_CAPS.image, false, 'fallback is all-false outside Vite');

console.log('capabilities.check: ok');
