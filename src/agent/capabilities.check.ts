// capabilities.check.ts — on/off partition, fallback wiring, and the tsx-safe
// (no vite define) fallback of the configured-capabilities manifest.
//   npx tsx src/agent/capabilities.check.ts
import assert from 'node:assert/strict';
import { applyLiveKeyStatus, capabilitiesPrompt, CONFIGURED_CAPS, type CapabilityKey } from './capabilities';

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

// ── vendor granularity: with live key status, ON capabilities name the EXACT tool arg ──
applyLiveKeyStatus({ KLING_API_KEY: { configured: true } });
const vendored = capabilitiesPrompt({ ...ALL_OFF, video: true });
assert.ok(vendored.includes('可灵(model=kling)'), 'configured vendor named with its tool arg');
assert.ok(!vendored.includes('seedance2'), 'unconfigured vendor NOT listed');
applyLiveKeyStatus({ MINIMAX_API_KEY: { configured: true } });
const mm = capabilitiesPrompt({ ...ALL_OFF, video: true, image: true, voice: true, music: true });
assert.ok(mm.includes('海螺(model=hailuo)') && mm.includes('MiniMax(model=image-01)')
  && mm.includes('MiniMax(provider=minimax)'), 'one minimax key lights all its vendor rows');
applyLiveKeyStatus({ DOUBAO_TTS_APP_ID: { configured: true } });
const half = capabilitiesPrompt({ ...ALL_OFF, voice: true });
assert.ok(!half.includes('豆包(provider=doubao)'), 'AND-group (doubao needs both keys) not satisfied by one');

// ── tsx (no vite define): CONFIGURED_CAPS falls back to all-false without throwing ──
assert.equal(typeof CONFIGURED_CAPS.image, 'boolean', 'CONFIGURED_CAPS resolves under tsx (all-false fallback, no ReferenceError)');
assert.equal(CONFIGURED_CAPS.image, false, 'fallback is all-false outside Vite');

console.log('capabilities.check: ok');
