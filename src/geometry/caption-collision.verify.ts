import assert from 'node:assert/strict';
import {
  bestCaptionLayoutForGeometries,
  captionBandFromLayout,
  captionFaceConflicts,
  faceUnionOf,
  geometryWithinSourceRanges,
  suggestCaptionAvoidance,
} from './caption-collision';
import { captionGeometryTargets, layoutsOf, visibleGeometryForCaptionTarget } from './caption-qa';
import type { VisualGeometryAsset } from './visual-geometry';
import type { GeomRect } from './geometry-math';
import type { CaptionsData } from '../captions/types';
import type { ProjectDoc, TimelineState } from '../editor/types';
import { resolveEffectiveCaptionLanes } from '../captions/lanes';

const geometryWith = (face: GeomRect | null): VisualGeometryAsset => ({
  assetId: 'a',
  sourceRevision: 'r',
  algorithmVersion: 'v',
  durationSec: 10,
  segments: [
    {
      startSec: 0,
      endSec: 10,
      person: face ? (face.x + face.w / 2 < 0.4 ? 'left' : face.x + face.w / 2 > 0.6 ? 'right' : 'center') : 'none',
      zone: { rects: [], face, subject: face },
    },
  ],
});

async function main(): Promise<void> {
  // 1. Default bottom-center caption vs a low-mid face → conflict.
  const faceMid = geometryWith({ x: 0.3, y: 0.6, w: 0.4, h: 0.3 });
  const defaults = [{ anchor: 'bottom-center', offsetXRatio: 0, offsetYRatio: 0 }];
  const conflicts = captionFaceConflicts(faceMid, defaults);
  assert.equal(conflicts.length, 1, 'bottom caption over a low face must flag');
  assert.ok(conflicts[0]!.coverage > 0.2);

  // 2. Face near the bottom edge (speaker sitting low) → still flagged.
  const faceLow = geometryWith({ x: 0.3, y: 0.7, w: 0.4, h: 0.25 });
  assert.equal(captionFaceConflicts(faceLow, defaults).length, 1);

  // 3. No face → no conflict.
  assert.equal(captionFaceConflicts(geometryWith(null), defaults).length, 0);

  // 4. Top-anchored caption vs face at bottom → no conflict (different band).
  const topLayout = [{ anchor: 'top-center', offsetXRatio: 0, offsetYRatio: 0 }];
  assert.equal(captionFaceConflicts(faceLow, topLayout).length, 0);

  // 5. Offset moves the caption out of the face band → no conflict.
  const shifted = [{ anchor: 'bottom-center', offsetXRatio: 0, offsetYRatio: 0.5 }];
  assert.equal(captionFaceConflicts(faceMid, shifted).length, 0, 'moved up clear of the face');

  // 6. faceUnionOf merges faces across segments.
  const twoSegments: VisualGeometryAsset = {
    assetId: 'a', sourceRevision: 'r', algorithmVersion: 'v', durationSec: 20,
    segments: [
      { startSec: 0, endSec: 10, person: 'left', zone: { rects: [], face: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, subject: null } },
      { startSec: 10, endSec: 20, person: 'right', zone: { rects: [], face: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 }, subject: null } },
    ],
  };
  const union = faceUnionOf(twoSegments);
  assert.ok(union, 'face union present');
  assert.ok(Math.abs(union.w - 0.8) < 1e-6, 'union spans both sides');

  // 7. captionBandFromLayout mapping sanity.
  const band = captionBandFromLayout({ anchor: 'bottom-center', offsetXRatio: 0, offsetYRatio: 0 })!;
  assert.ok(Math.abs((band.y + band.h / 2) - 0.92) < 1e-6, 'bottom center at y≈0.92');
  const top = captionBandFromLayout({ anchor: 'top-left', offsetXRatio: 0, offsetYRatio: 0 })!;
  assert.ok(Math.abs((top.x + top.w / 2) - 0.25) < 1e-6, 'top-left centers at x≈0.25');

  // 8. Avoidance moves a conflicting bottom caption above the face.
  const lowFace = geometryWith({ x: 0.3, y: 0.6, w: 0.4, h: 0.3 });
  const conflict = captionFaceConflicts(lowFace, defaults)[0]!;
  const suggestion = suggestCaptionAvoidance(conflict)!;
  assert.equal(suggestion.side, 'above');
  const moved = captionBandFromLayout({ ...conflict.layout, offsetYRatio: suggestion.offsetYRatio })!;
  assert.equal(captionFaceConflicts(lowFace, [{ ...conflict.layout, offsetYRatio: suggestion.offsetYRatio }]).length, 0, 'suggested offset clears the face');
  assert.ok(moved.y + moved.h <= 0.6 - 1e-6, 'band sits above the face top');

  // 9. Face spanning the full height → no suggestion possible.
  const fullFace = geometryWith({ x: 0.2, y: 0.02, w: 0.6, h: 0.96 });
  const fullConflict = captionFaceConflicts(fullFace, defaults)[0]!;
  assert.equal(suggestCaptionAvoidance(fullConflict), null, 'no room above or below');

  // 10. No face detected → subject top band stands in (conservative avoidance).
  const noFace = {
    assetId: 'a', sourceRevision: 'r', algorithmVersion: 'v', durationSec: 10,
    segments: [{
      startSec: 0, endSec: 10, person: 'center',
      zone: { rects: [], face: null, subject: { x: 0.3, y: 0.85, w: 0.4, h: 0.15 } },
    }],
  } as VisualGeometryAsset;
  const headUnion = faceUnionOf(noFace)!;
  assert.ok(headUnion, 'subject top band replaces the missing face');
  assert.ok(Math.abs(headUnion.y - 0.85) < 1e-6, 'band starts at subject top');
  assert.ok(Math.abs(headUnion.h - 0.0525) < 1e-6, 'band is the top 35% of the subject');
  const noFaceConflicts = captionFaceConflicts(noFace, defaults);
  assert.equal(noFaceConflicts.length, 1, 'bottom caption over the subject head band flags even without a face');

  // 11. Geometry-derived defaults move away from a low face.
  const best = bestCaptionLayoutForGeometries([faceLow]);
  assert.equal(best.anchor, 'top-center');
  assert.equal(captionFaceConflicts(faceLow, [best]).length, 0);

  // 12. Policy resolution matches renderer precedence and stacking.
  const baseCaptions = {
    enabled: true,
    template: 'plain',
    pacing: 'phrase',
    layout: { anchor: 'top-left' },
  } satisfies CaptionsData;
  const perSource = layoutsOf({
    ...baseCaptions,
    sourceEntries: [
      { id: 'speaker-a', itemId: 'clip-a', offsetYRatio: 0.1 },
      { id: 'speaker-b', itemId: 'clip-b', visible: false },
    ],
  });
  assert.deepEqual(perSource, [{ anchor: 'top-left', stackCount: 1 }], 'offset without an entry anchor is renderer-inert');
  assert.deepEqual(layoutsOf(baseCaptions), [{ anchor: 'top-left', stackCount: 1 }]);
  const slotted = layoutsOf({
    ...baseCaptions,
    sourceEntries: [
      { id: 'speaker-a', itemId: 'clip-a', anchor: 'bottom-right', slotId: 'left-slot' },
      { id: 'speaker-b', itemId: 'clip-b', anchor: 'bottom-left', slotId: 'left-slot' },
    ],
    layoutPolicy: { mode: 'manual-slots', slots: [{ id: 'left-slot', anchor: 'middle-left', offsetYRatio: 0.1 }] },
  });
  assert.deepEqual(slotted, [{ anchor: 'middle-left', offsetXRatio: undefined, offsetYRatio: 0.1, stackCount: 2 }]);
  const slotGroups = resolveEffectiveCaptionLanes({
    ...baseCaptions,
    sourceEntries: [
      { id: 'speaker-a', itemId: 'clip-a', anchor: 'bottom-right', slotId: 'left-slot' },
      { id: 'speaker-b', itemId: 'clip-b', anchor: 'bottom-left', slotId: 'left-slot' },
    ],
    layoutPolicy: { mode: 'manual-slots', slots: [{ id: 'left-slot', anchor: 'middle-left', offsetYRatio: 0.1 }] },
  }, [
    { id: 'speaker-a', itemId: 'clip-a', anchor: 'bottom-right', slotId: 'left-slot' },
    { id: 'speaker-b', itemId: 'clip-b', anchor: 'bottom-left', slotId: 'left-slot' },
  ]);
  assert.deepEqual(slotGroups[0]?.placementSources, [{ kind: 'slot', slotId: 'left-slot' }], 'avoidance must write the policy slot');
  const single = resolveEffectiveCaptionLanes({
    ...baseCaptions,
    sourceEntries: [
      { id: 'low', itemId: 'clip-a', anchor: 'top-left', priority: 10 },
      { id: 'high', itemId: 'clip-b', anchor: 'bottom-right', priority: 1 },
    ],
    layoutPolicy: { mode: 'single-lane', maxVisibleSources: 1 },
  }, [
    { id: 'low', itemId: 'clip-a', anchor: 'top-left', priority: 10 },
    { id: 'high', itemId: 'clip-b', anchor: 'bottom-right', priority: 1 },
  ]);
  assert.deepEqual(single.map((group) => group.entries.map((entry) => entry.id)), [['high']]);
  assert.deepEqual(single[0]?.placementSources, [{ kind: 'layout' }], 'single-lane renderer ignores entry placement');

  // 13. Renderer transform signs, stacking, scale, and rotation expand the same QA band.
  const bottomUp = captionBandFromLayout({ anchor: 'bottom-center', offsetYRatio: 0.2 })!;
  assert.ok(bottomUp.y < band.y, 'positive bottom offset moves upward like containerStyle');
  const rightShift = captionBandFromLayout({ anchor: 'top-right', offsetXRatio: 0.1 })!;
  assert.ok(rightShift.x + rightShift.w / 2 > 0.75, 'positive X always moves right');
  const stacked = captionBandFromLayout({ anchor: 'bottom-center', stackCount: 2 })!;
  assert.ok(Math.abs(stacked.h - 0.28) < 1e-6 && Math.abs(stacked.y + stacked.h - (band.y + band.h)) < 1e-6);
  const transformed = captionBandFromLayout({ anchor: 'bottom-center', scale: 1.2, rotation: 20 })!;
  assert.ok(transformed.w > band.w && transformed.h > band.h, 'transforms use a conservative AABB');
  const scaledAroundCanvas = captionBandFromLayout({ anchor: 'bottom-center', scale: 2 })!;
  assert.ok(Math.abs(scaledAroundCanvas.y + scaledAroundCanvas.h / 2 - 1.34) < 1e-6, 'scale follows the full-canvas container transform origin');

  // 14. Only geometry segments in active source windows survive.
  const currentScene = geometryWithinSourceRanges(twoSegments, [{ startSec: 12, endSec: 14 }]);
  assert.equal(currentScene.segments.length, 1);
  assert.equal(currentScene.segments[0]?.person, 'right');
  assert.deepEqual({ startSec: currentScene.segments[0]?.startSec, endSec: currentScene.segments[0]?.endSec }, { startSec: 12, endSec: 14 });

  // 15. Audio-backed captions inspect the active composited video, not the audio asset or stale/hidden clips.
  const captions: CaptionsData = {
    enabled: true,
    template: 'plain',
    pacing: 'phrase',
    sourceItemId: 'audio-caption-source',
  };
  const state = {
    fps: 30,
    width: 1920,
    height: 1080,
    selectedId: null,
    trackOrder: ['V1', 'V-hidden', 'A1'],
    tracks: {
      V1: { kind: 'video' },
      'V-hidden': { kind: 'video', hidden: true },
      A1: { kind: 'audio' },
    },
    items: [
      { id: 'old-picture', track: 'V1', startFrame: 0, durationInFrames: 30, name: 'old', kind: 'video', src: '/old.mp4', sourceAssetId: 'old' },
      {
        id: 'talking-head',
        track: 'V1',
        startFrame: 30,
        durationInFrames: 60,
        name: 'head',
        kind: 'video',
        src: '/head.mp4',
        sourceAssetId: 'head',
        srcInFrame: 60,
        playbackRate: 2,
        width: 1920,
        height: 1080,
        transform: { x: 20, y: 0, scale: 0.5 },
      },
      { id: 'hidden-picture', track: 'V-hidden', startFrame: 30, durationInFrames: 60, name: 'hidden', kind: 'video', src: '/hidden.mp4', sourceAssetId: 'hidden' },
      {
        id: 'audio-caption-source',
        track: 'A1',
        startFrame: 30,
        durationInFrames: 30,
        name: 'voice',
        kind: 'audio',
        src: '/voice.wav',
        sourceAssetId: 'voice',
        transcript: [{ text: 'hello', start: 0, end: 500 }],
      },
    ],
    captions,
  } as TimelineState;
  const doc = {
    assets: [
      { id: 'old', name: 'old', kind: 'video', src: '/old.mp4', durationInFrames: 30 },
      { id: 'head', name: 'head', kind: 'video', src: '/head.mp4', durationInFrames: 180 },
      { id: 'hidden', name: 'hidden', kind: 'video', src: '/hidden.mp4', durationInFrames: 60 },
      { id: 'voice', name: 'voice', kind: 'audio', src: '/voice.wav', durationInFrames: 30 },
    ],
  } as ProjectDoc;
  const targets = captionGeometryTargets(captions, state, doc);
  assert.deepEqual(targets.map((target) => target.asset.id), ['head']);
  assert.equal(targets[0]?.visualItem.id, 'talking-head');
  assert.deepEqual(targets[0]?.sourceRanges, [{ startSec: 2, endSec: 6 }], 'trim and playback rate map timeline overlap to source time');
  const projected = visibleGeometryForCaptionTarget(
    geometryWith({ x: 0.3, y: 0.6, w: 0.4, h: 0.3 }),
    state,
    targets[0]!,
  );
  const projectedFace = projected.segments[0]?.zone.face;
  assert.ok(projectedFace && projectedFace.x > 0.3 && projectedFace.w < 0.4, 'QA geometry follows the visible clip transform');

  console.log('caption-collision.verify: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
