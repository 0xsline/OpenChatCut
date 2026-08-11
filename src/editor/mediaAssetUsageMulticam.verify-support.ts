import assert from 'node:assert/strict';
import { projectReduce } from './reduce';
import type { MediaAsset, ProjectDoc, Timeline, TimelineItem } from './types';

type ClipFactory = (id: string, name: string, src: string, sourceAssetId?: string) => TimelineItem;

export const verifyMulticamAssetRemoval = ({
  doc,
  assetA,
  assetB,
  otherAsset,
  clip,
}: {
  doc: ProjectDoc;
  assetA: MediaAsset;
  assetB: MediaAsset;
  otherAsset: MediaAsset;
  clip: ClipFactory;
}): void => {
  const targetAngleA = {
    ...clip('multicam-a', assetA.name, assetA.src, assetA.id),
    durationInFrames: 45,
    multicamGroupId: 'multicam-target',
    multicamAngleId: 'target-angle-a',
  };
  const targetAngleB = {
    ...clip('multicam-b', assetB.name, assetB.src, assetB.id),
    durationInFrames: 45,
    multicamGroupId: 'multicam-target',
    multicamAngleId: 'target-angle-b',
  };
  const targetAngleBSplit = {
    ...targetAngleB,
    id: 'multicam-b-split',
    startFrame: 45,
  };
  const independentAngleB = {
    ...clip('independent-b', assetB.name, assetB.src, assetB.id),
    multicamGroupId: 'multicam-independent',
    multicamAngleId: 'independent-angle-b',
  };
  const independentAngleC = {
    ...clip('independent-c', otherAsset.name, otherAsset.src, otherAsset.id),
    multicamGroupId: 'multicam-independent',
    multicamAngleId: 'independent-angle-c',
  };
  const multicamTimeline: Timeline = {
    ...doc.timelines[0]!,
    id: 'multicam-timeline',
    items: [targetAngleA, targetAngleB, targetAngleBSplit, independentAngleB, independentAngleC],
    multicamGroups: [
      {
        id: 'multicam-target',
        referenceAngleId: 'target-angle-a',
        masterAngleId: 'target-angle-a',
        angles: [
          {
            id: 'target-angle-a',
            itemId: targetAngleA.id,
            source: targetAngleA,
            label: 'Camera A',
            offsetFrames: 0,
            confidence: 1,
          },
          {
            id: 'target-angle-b',
            itemId: targetAngleB.id,
            source: targetAngleB,
            label: 'Camera B',
            offsetFrames: 0,
            confidence: 1,
          },
        ],
        syncMethod: 'audio' as const,
        evidence: [],
      },
      {
        id: 'multicam-independent',
        referenceAngleId: 'independent-angle-b',
        masterAngleId: 'independent-angle-b',
        angles: [
          {
            id: 'independent-angle-b',
            itemId: independentAngleB.id,
            source: independentAngleB,
            label: 'Independent B',
            offsetFrames: 0,
            confidence: 1,
          },
          {
            id: 'independent-angle-c',
            itemId: independentAngleC.id,
            source: independentAngleC,
            label: 'Independent C',
            offsetFrames: 0,
            confidence: 1,
          },
        ],
        syncMethod: 'audio' as const,
        evidence: [],
      },
    ],
  };
  const removedMulticam = projectReduce(
    {
      ...doc,
      activeTimelineId: multicamTimeline.id,
      timelines: [multicamTimeline],
    },
    { type: 'pool.removeAsset', id: assetA.id },
  ).timelines[0]!;
  assert.equal(
    removedMulticam.items.some((item) => item.id === targetAngleA.id),
    false,
    'the deleted asset angle must be removed from the timeline',
  );
  assert.deepEqual(
    removedMulticam.multicamGroups?.map((group) => group.id),
    ['multicam-independent'],
    'deleting one angle from a two-angle group must collapse only that group',
  );
  for (const id of [targetAngleB.id, targetAngleBSplit.id]) {
    const survivor = removedMulticam.items.find((item) => item.id === id);
    assert.equal(survivor?.multicamGroupId, undefined, 'collapsed group membership must be removed from survivors');
    assert.equal(survivor?.multicamAngleId, undefined, 'collapsed angle membership must be removed from split descendants');
  }
  assert.equal(
    removedMulticam.items.find((item) => item.id === independentAngleB.id)?.multicamGroupId,
    'multicam-independent',
    'unrelated multicam membership must be preserved',
  );
  const survivingMulticamGroupIds = new Set(removedMulticam.multicamGroups?.map((group) => group.id) ?? []);
  for (const item of removedMulticam.items) {
    assert.ok(
      !item.multicamGroupId || survivingMulticamGroupIds.has(item.multicamGroupId),
      `timeline item ${item.id} must not reference a missing multicam group`,
    );
  }
};
