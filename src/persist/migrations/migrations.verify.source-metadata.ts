import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import { loadProject, migrateProjectDoc, resetProjectStoreMemory } from '../projectStore';
import { kvGet, kvSet } from '../sharedKv';
import { listTemplates, saveTemplate } from '../templateStore';

// Runtime migration normalizes string source filenames and removes malformed
// values from every media-source shape while retaining desktop-only local paths.
export const verifySourceMetadataMigration = async (): Promise<void> => {
  const privatePath = '/Users/local-editor/private/interview.mov';
  const hostileItem = {
    id: 'clip_hostile',
    track: 'track_tl_sources_1',
    startFrame: 0,
    durationInFrames: 30,
    name: 'Hostile',
    kind: 'video',
    src: '/media/uploads/hostile.mov',
    sourceFilename: { attacker: true },
    originalFilePath: 'relative/private/interview.mov',
    sourceRevision: 'bad\u0001revision',
    sourceContentHash: 'not-a-sha256',
  };
  const validItem = {
    ...hostileItem,
    id: 'clip_valid',
    name: 'Valid',
    sourceFilename: '/Users/editor/采访/interview.final.mov',
    originalFilePath: privatePath,
    sourceContentHash: 'AB'.repeat(32),
  };
  const hostileDoc = {
    version: CURRENT_PROJECT_VERSION,
    assets: [
      {
        id: 'asset_hostile',
        name: 'Hostile',
        kind: 'video',
        src: '/media/uploads/hostile.mov',
        durationInFrames: 30,
        sourceFilename: 'bad\u0001.mov',
        originalFilePath: privatePath,
        sourceRevision: 'bad\u0001revision',
        sourceContentHash: 'not-a-sha256',
        sourceSize: -1,
        sourceModifiedAt: Number.POSITIVE_INFINITY,
        sourceTimecode: { frameCount: -1, frameRate: { numerator: 0, denominator: 1 }, dropFrame: 'yes' },
        captureClock: { frameCount: Number.NaN, frameRate: { numerator: 30, denominator: 1 }, dropFrame: false },
      },
      {
        id: 'asset_valid',
        name: 'Valid',
        kind: 'video',
        src: '/media/uploads/valid.mov',
        durationInFrames: 30,
        sourceFilename: 'D:\\capture\\interview.final.mov',
        sourceContentHash: 'CD'.repeat(32),
        sourceSize: 0,
        sourceModifiedAt: 0,
        sourceTimecode: { frameCount: 1_800, frameRate: { numerator: 30_000, denominator: 1_001 }, dropFrame: true },
      },
    ],
    mediaFolders: [],
    timelines: [{
      id: 'tl_sources',
      name: 'Source metadata',
      order: 0,
      fps: 30,
      width: 1920,
      height: 1080,
      trackOrder: ['track_tl_sources_1'],
      tracks: { track_tl_sources_1: { kind: 'video' } },
      items: [hostileItem, validItem],
      multicamGroups: [{
        id: 'group_sources',
        referenceAngleId: 'angle_hostile',
        masterAngleId: 'angle_hostile',
        syncMethod: 'audio',
        angles: [
          {
            id: 'angle_hostile',
            itemId: hostileItem.id,
            label: 'Hostile',
            micRole: 'camera',
            offsetFrames: 0,
            confidence: 1,
            source: { ...hostileItem, sourceFilename: ['private.mov'] },
          },
          {
            id: 'angle_valid',
            itemId: validItem.id,
            label: 'Valid',
            micRole: 'camera',
            offsetFrames: 0,
            confidence: 1,
            source: { ...validItem, sourceFilename: '\\\\server\\share\\机位.最终版.001.mov' },
          },
        ],
        evidence: [
          { angleId: 'angle_hostile', method: 'audio', confidence: 1, offsetFrames: 0 },
          { angleId: 'angle_valid', method: 'audio', confidence: 1, offsetFrames: 0 },
        ],
        decisions: [],
      }],
      selectedId: null,
    }],
    activeTimelineId: 'tl_sources',
  };
  const migrated = migrateProjectDoc(hostileDoc);
  assert.ok(migrated);
  assert.equal(migrated.assets[0]?.sourceFilename, undefined);
  assert.equal(migrated.assets[1]?.sourceFilename, 'interview.final.mov', 'asset Windows path becomes a basename');
  assert.equal(migrated.timelines[0]?.items[0]?.sourceFilename, undefined);
  assert.equal(migrated.timelines[0]?.items[1]?.sourceFilename, 'interview.final.mov', 'item POSIX path becomes a basename');
  assert.equal(migrated.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.sourceFilename, undefined);
  assert.equal(migrated.timelines[0]?.multicamGroups?.[0]?.angles[1]?.source.sourceFilename, '机位.最终版.001.mov',
    'multicam UNC path becomes a basename without losing Chinese or multiple dots');
  assert.equal(migrated.assets[0]?.originalFilePath, privatePath, 'local migration retains desktop source paths');
  assert.equal(migrated.assets[0]?.sourceContentHash, undefined);
  assert.notEqual(migrated.assets[0]?.sourceRevision, 'bad\u0001revision');
  assert.equal(migrated.assets[0]?.sourceSize, undefined);
  assert.equal(migrated.assets[0]?.sourceModifiedAt, undefined);
  assert.equal(migrated.assets[0]?.sourceTimecode, undefined);
  assert.equal(migrated.assets[0]?.captureClock, undefined);
  assert.equal(migrated.assets[1]?.sourceContentHash, 'cd'.repeat(32));
  assert.equal(migrated.assets[1]?.sourceSize, 0);
  assert.equal(migrated.assets[1]?.sourceModifiedAt, 0);
  assert.equal(migrated.assets[1]?.sourceTimecode?.frameRate.numerator, 30_000);
  assert.equal(migrated.timelines[0]?.items[0]?.sourceContentHash, undefined);
  assert.equal(migrated.timelines[0]?.items[0]?.originalFilePath, undefined);
  assert.equal(migrated.timelines[0]?.items[1]?.sourceContentHash, 'ab'.repeat(32));
  assert.equal(migrated.timelines[0]?.items[1]?.originalFilePath, privatePath);
  assert.equal(hostileDoc.assets[0]?.sourceFilename, 'bad\u0001.mov', 'migration never mutates hostile input');

  resetProjectStoreMemory();
  await kvSet('project:local-source-path', migrated);
  assert.equal((await loadProject('local-source-path'))?.assets[0]?.originalFilePath, privatePath,
    'local project persistence retains a legal desktop source path');

  resetProjectStoreMemory();
  await kvSet('templates:all', [{
    id: 'template_private',
    name: 'Old private template',
    createdAt: 1,
    doc: migrated,
    assetIds: ['asset_hostile'],
  }]);
  const oldTemplate = (await listTemplates())[0]!;
  assert.equal(oldTemplate.doc.assets[0]?.originalFilePath, undefined);
  assert.equal(oldTemplate.doc.timelines[0]?.items[0]?.originalFilePath, undefined);
  assert.equal(oldTemplate.doc.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.originalFilePath, undefined);
  assert.equal(oldTemplate.doc.assets[1]?.sourceFilename, 'interview.final.mov');
  assert.equal(JSON.stringify(await kvGet('templates:all')).includes(privatePath), false,
    'reading an old shared template rewrites its portable ProjectDoc');

  resetProjectStoreMemory();
  const liveDoc = structuredClone(migrated);
  const savedTemplate = await saveTemplate('Portable', liveDoc);
  assert.equal(JSON.stringify(savedTemplate.doc).includes(privatePath), false);
  assert.equal(JSON.stringify(await kvGet('templates:all')).includes(privatePath), false);
  assert.equal(liveDoc.assets[0]?.originalFilePath, privatePath, 'template save never mutates the live ProjectDoc');
};
