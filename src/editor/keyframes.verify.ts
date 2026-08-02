// Runnable check: `npx tsx src/editor/keyframes.verify.ts`.
// Verification: volume keyframe channel - volumeAtFrame fallback/override/interpolation/out-of-bounds clamping; split carry
// The volume channel and the sampling on both sides of the cut point are consistent; the registry supports dispatching by kind; the reducer is
// setKeyframe accepts audio volume and rejects picture volume; tool layer per-prop verification.
import assert from 'node:assert/strict';
import { sampleKeyframes, splitItemKeyframes, volumeAtFrame } from './keyframes';
import {
  KEYFRAME_PROPS, coerceKeyframeValue, getKeyframePropertyDefinition, supportsKeyframeProperty,
} from './keyframeRegistry';
import { reduce } from './reduce';
import type { TimelineItem, TimelineState } from './types';

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;
const item = (patch: Partial<TimelineItem>): TimelineItem => ({
  id: 'a1', track: 'a-audio-1', startFrame: 0, durationInFrames: 120, kind: 'audio', name: 'a', ...patch,
} as TimelineItem);

// ── volumeAtFrame: no keyframe to fall back to static volume; with keyframe to overwrite the static value and interpolate by frame ──
assert.equal(volumeAtFrame({}, 10), 1, '无 volume 字段默认 1');
assert.equal(volumeAtFrame({ volume: 0.4 }, 10), 0.4, '无关键帧回退 item.volume');
const ducked = { volume: 0.3, keyframes: { volume: [{ frame: 0, value: 1 }, { frame: 10, value: 0.2 }] } };
assert.equal(volumeAtFrame(ducked, 0), 1, '关键帧覆盖静态音量');
assert.ok(near(volumeAtFrame(ducked, 5), 0.6), '线性插值中点');
assert.equal(volumeAtFrame(ducked, 999), 0.2, '越过末帧保持末值');
assert.equal(volumeAtFrame(ducked, -5), 1, '首帧之前保持首值');

// ── Clamp: overshoot Bezier can sample >2 between inbound keyframes, and must be clamped back to 0..2 ──
const shoot = { keyframes: { volume: [{ frame: 0, value: 0, easing: [0.3, 3, 0.7, 3] as [number, number, number, number] }, { frame: 10, value: 2 }] } };
const rawMid = sampleKeyframes(shoot.keyframes.volume, 5);
assert.ok(rawMid > 2, `构造的 overshoot 中点应 >2(实际 ${rawMid.toFixed(3)})`);
assert.equal(volumeAtFrame(shoot, 5), 2, 'overshoot 钳到 2');

// ── split:volume The channel is split with cutting, and the sampling on both sides of the cutting point is consistent with that before cutting frame by frame ──
const kfs = { volume: [{ frame: 0, value: 1 }, { frame: 40, value: 0.2 }, { frame: 100, value: 1.6 }] };
const [l, r] = splitItemKeyframes(kfs, 30);
assert.ok(l?.volume?.length && r?.volume?.length, 'split 两侧都有 volume 通道');
for (let f = 0; f < 120; f++) {
  const orig = sampleKeyframes(kfs.volume, f);
  const post = f < 30 ? sampleKeyframes(l!.volume!, f) : sampleKeyframes(r!.volume!, f - 30);
  assert.ok(near(orig, post, 1e-9), `帧 ${f} 切前后采样一致`);
}

// ── Registry: volume in KEYFRAME_PROPS; audio/video supported, image not supported; coerce clamp 0..2 ──
assert.ok(KEYFRAME_PROPS.includes('volume'), 'KEYFRAME_PROPS 含 volume');
const def = getKeyframePropertyDefinition('volume');
assert.deepEqual([...def.valueRange], [0, 2], 'volume valueRange 0..2');
assert.equal(def.getBaseValue(item({ volume: 0.7 })), 0.7, 'getBaseValue 读 item.volume');
assert.ok(supportsKeyframeProperty(item({ kind: 'audio' }), 'volume'), 'audio 支持 volume');
assert.ok(supportsKeyframeProperty(item({ kind: 'video' }), 'volume'), 'video 支持 volume');
assert.ok(!supportsKeyframeProperty(item({ kind: 'image' }), 'volume'), 'image 不支持 volume');
assert.ok(!supportsKeyframeProperty(item({ kind: 'audio' }), 'opacity'), 'audio 仍不支持 opacity');
const opacityDef = getKeyframePropertyDefinition('opacity');
assert.equal(opacityDef.getBaseValue(item({ kind: 'image', transform: { opacity: 0.45 } })), 0.45, 'opacity 读取静态 transform');
assert.deepEqual(opacityDef.toTransformPatch?.(0.6), { opacity: 0.6 }, 'opacity 可写回静态 transform');
const radiusDef = getKeyframePropertyDefinition('borderRadius');
assert.ok(KEYFRAME_PROPS.includes('borderRadius'), 'KEYFRAME_PROPS 含 borderRadius');
assert.ok(supportsKeyframeProperty(item({ kind: 'image' }), 'borderRadius'), '图片支持圆角');
assert.ok(!supportsKeyframeProperty(item({ kind: 'text' }), 'borderRadius'), '文字不开放圆角');
assert.deepEqual(radiusDef.toTransformPatch?.(24), { borderRadius: 24 }, '圆角可写回静态 transform');
assert.equal(coerceKeyframeValue('borderRadius', 1200), 1000, '圆角关键帧按范围钳制');
assert.equal(coerceKeyframeValue('volume', 9), 2, 'coerce 上钳 2');
assert.equal(coerceKeyframeValue('volume', -1), 0, 'coerce 下钳 0');

// ── reducer:setKeyframe accepts audio+volume; rejects image+volume(state as is) ──
const base: TimelineState = {
  fps: 30, width: 1920, height: 1080, selectedId: null,
  tracks: { 'a-audio-1': { kind: 'audio' }, 'a-video-1': { kind: 'video' } },
  trackOrder: ['a-video-1', 'a-audio-1'],
  items: [item({ kind: 'audio' }), item({ id: 'i1', kind: 'image', track: 'a-video-1' })],
};
const s1 = reduce(base, { type: 'setKeyframe', id: 'a1', prop: 'volume', frame: 12, value: 0.5 });
assert.deepEqual(s1.items[0].keyframes?.volume, [{ frame: 12, value: 0.5 }], 'reducer 写入音频 volume 关键帧');
const s2 = reduce(base, { type: 'setKeyframe', id: 'i1', prop: 'volume', frame: 12, value: 0.5 });
assert.equal(s2, base, 'image 上的 volume 关键帧被拒(state 不变)');
const s3 = reduce(s1, { type: 'setKeyframe', id: 'a1', prop: 'volume', frame: 20, value: 7 });
assert.deepEqual(s3.items[0].keyframes?.volume?.map((k) => k.value), [0.5, 2], 'reducer 写入时按 valueRange 钳制');

// ── Tool layer: edit_item verification per-prop support and scope ──
const { validateGenericUpdate } = await import('../agent/tools/edit-item-generic');
const okAudio = validateGenericUpdate(base, { type: 'update', itemId: 'a1', keyframes: { volume: [{ frame: 0, value: 1.5 }] } });
assert.ok(!('error' in okAudio && okAudio.error), 'audio+volume 关键帧通过校验');
const badImage = validateGenericUpdate(base, { type: 'update', itemId: 'i1', keyframes: { volume: [{ frame: 0, value: 1 }] } }) as { error?: string };
assert.match(badImage.error ?? '', /not supported on a image/, 'image+volume 被拒并报 kind');
const badAudioOpacity = validateGenericUpdate(base, { type: 'update', itemId: 'a1', keyframes: { opacity: [{ frame: 0, value: 0.5 }] } }) as { error?: string };
assert.match(badAudioOpacity.error ?? '', /not supported on a audio/, 'audio+opacity 被拒');
const badRange = validateGenericUpdate(base, { type: 'update', itemId: 'a1', keyframes: { volume: [{ frame: 0, value: 3 }] } }) as { error?: string };
assert.match(badRange.error ?? '', /0\.\.2/, 'volume>2 被范围校验拒绝');

console.log('keyframes.verify: all assertions passed');
