// Caption template fallback, translation staleness, and FCPXML retime/asset
// kind. All three are "newer data opened by older code" or "edit invalidates
// derived data" cases. npx tsx src/captions/captionFallback.verify.ts
import assert from 'node:assert/strict';
import type { TimelineItem, TimelineState } from '../editor/types';
import type { CaptionsData } from './types';
import { CAPTION_STYLE_BY_ID, captionStyleFor, FALLBACK_CAPTION_TEMPLATE } from './styles';
import { effectivePreset } from './renderStyles';
import { captionTimingFingerprint, isTranslationStale } from './translate';
import { timelineToFcpxml } from '../export/fcpxml';

// ── 未知模板 id 兜底(旧版打开新版工程时不得崩掉预览/导出) ──────────────────
{
  assert.equal(captionStyleFor('plain').id, 'plain', 'known template resolves');
  assert.equal(captionStyleFor('a-template-from-the-future').id, FALLBACK_CAPTION_TEMPLATE,
    'unknown template falls back instead of returning undefined');
  assert.equal(captionStyleFor(undefined).id, FALLBACK_CAPTION_TEMPLATE, 'undefined falls back');
  assert.equal(captionStyleFor(42).id, FALLBACK_CAPTION_TEMPLATE, 'non-string falls back');
  assert.ok(CAPTION_STYLE_BY_ID[FALLBACK_CAPTION_TEMPLATE], 'the fallback template exists');

  // effectivePreset used to throw on `preset.fontFamily` for an unknown id.
  const captions = { template: 'future-template', enabled: true } as unknown as CaptionsData;
  const preset = effectivePreset(captions);
  assert.equal(typeof preset.fontFamily, 'string', 'preset resolves without throwing');
  const overridden = effectivePreset({ ...captions, styleOverride: { color: '#f00' } } as CaptionsData);
  assert.equal(overridden.color, '#f00', 'style override still layers over the fallback');
}

// ── 翻译过期判定 ──────────────────────────────────────────────────────────
{
  const words = [
    { text: 'a', start: 0, end: 500 },
    { text: 'b', start: 500, end: 1000 },
  ];
  const base = {
    template: 'plain', enabled: true, words, offsetFrames: 0,
  } as unknown as CaptionsData;
  const items: TimelineItem[] = [];
  const fps = 30;
  const fingerprint = captionTimingFingerprint(base, items, fps);
  assert.ok(fingerprint.length > 0, 'fingerprint is produced');

  assert.equal(isTranslationStale(base, items, fps), false, 'no translation = not stale');
  const translated = {
    ...base,
    translation: [{ start: 0, end: 1000, text: 'x' }],
    translationFingerprint: fingerprint,
  } as CaptionsData;
  assert.equal(isTranslationStale(translated, items, fps), false, 'matching fingerprint = fresh');

  const retimed = { ...translated, offsetFrames: 60 } as CaptionsData;
  assert.equal(isTranslationStale(retimed, items, fps), true,
    're-timed source makes the pinned translation stale');

  const legacy = { ...translated, translationFingerprint: undefined } as CaptionsData;
  assert.equal(isTranslationStale(legacy, items, fps), false,
    'older translations without a fingerprint are never reported stale');
}

// ── FCPXML:变速写入 timeMap;同 src 的 video/audio 取视觉 kind ──────────────
{
  const item = (over: Partial<TimelineItem>): TimelineItem => ({
    id: 'a', track: 'V1', startFrame: 0, durationInFrames: 90,
    kind: 'video', name: 'clip', src: '/m.mp4', ...over,
  } as TimelineItem);
  const state = (items: TimelineItem[]): TimelineState => ({
    fps: 30, width: 1920, height: 1080, selectedId: null, items,
  } as TimelineState);

  const plain = timelineToFcpxml(state([item({})]));
  assert.equal(/<timeMap>/.test(plain), false, 'rate 1 emits no timeMap');

  const fast = timelineToFcpxml(state([item({ playbackRate: 2 })]));
  assert.ok(/<timeMap>/.test(fast), '2x clip emits a timeMap');
  // 90 timeline frames at 2x consume 180 source frames.
  assert.ok(/value="180\/30s"/.test(fast), 'timeMap maps the full source span consumed');
  assert.ok(/time="90\/30s"/.test(fast), 'timeMap covers the clip timeline duration');
  assert.ok(/speed change 2x/.test(fast), 'the intended rate is recorded as a comment');

  // Same src used as audio first, then as video: the asset must stay visual.
  const mixed = timelineToFcpxml(state([
    item({ id: 'audio-first', kind: 'audio', track: 'A1' }),
    item({ id: 'video-second', kind: 'video', track: 'V1' }),
  ]));
  assert.ok(/hasVideo="1"/.test(mixed),
    'an asset used by both an audio and a video item still exports as video');
}

console.log('captionFallback.verify: ok');
