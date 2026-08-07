import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import { loadProject, migrateProjectDoc, resetProjectStoreMemory } from '../projectStore';
import { parseProjectEnvelope, PROJECT_EXPORT_FORMAT } from '../projectTransfer';
import { kvGet, kvSet } from '../sharedKv';
import { listTemplates, saveTemplate } from '../templateStore';
import { listVersions } from '../versionStore';
import { runProjectMigrations } from './index';

const fixture = (name: string): unknown => JSON.parse(
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'),
);

const v1 = fixture('project-v1.json');
const v2 = fixture('project-v2.json');
const v3 = fixture('project-v3.json');

{
  const sourceSnapshot = JSON.stringify(v1);
  const progress: Array<[number, number, number, number]> = [];
  const migrated = runProjectMigrations(v1, {
    onProgress: (event) => progress.push([
      event.fromVersion,
      event.toVersion,
      event.completedSteps,
      event.totalSteps,
    ]),
  });
  assert.ok(migrated);
  assert.equal(migrated.doc.version, CURRENT_PROJECT_VERSION);
  assert.deepEqual(migrated.appliedSteps, ['v1-to-v2', 'v2-to-v3', 'v3-to-v4']);
  assert.deepEqual(progress, [[1, 2, 1, 3], [2, 3, 2, 3], [3, 4, 3, 3]]);
  assert.deepEqual(migrated.doc.assets.map((asset) => asset.id), ['asset_video', 'asset_audio']);
  assert.equal(migrated.doc.assets[0].name, 'interview.mp4', 'project-level asset wins duplicate ids');
  assert.equal(migrated.doc.assets[0].folderId, undefined, 'missing folders are detached');
  assert.equal(migrated.doc.mediaFolders.find((folder) => folder.id === 'folder_orphan')?.parentId, undefined);
  assert.equal(migrated.doc.activeTimelineId, 'tl_fixture', 'stale active timeline falls back safely');
  assert.ok(migrated.doc.timelines.every((timeline) => !Object.hasOwn(timeline, 'assets')));
  assert.ok(migrated.doc.timelines[0].items.every((item) => item.track.startsWith('track_tl_fixture_')));
  assert.equal(JSON.stringify(v1), sourceSnapshot, 'migration steps never mutate source bytes');

  const repeated = migrateProjectDoc(migrated.doc);
  assert.deepEqual(repeated, migrated.doc, 'migrations are idempotent at the current version');
}

{
  const migrated = runProjectMigrations(v2, { onProgress: () => { throw new Error('observer failed'); } });
  assert.ok(migrated, 'progress observer failures do not invalidate migration');
}

{
  const migrated = runProjectMigrations(v2);
  assert.ok(migrated);
  assert.deepEqual(migrated.appliedSteps, ['v2-to-v3', 'v3-to-v4']);
  assert.equal(migrated.doc.timelines[0].items[0].track, 'track_tl_fixture_2');
}

{
  const migrated = runProjectMigrations(v3);
  assert.ok(migrated);
  assert.deepEqual(migrated.appliedSteps, ['v3-to-v4']);
  assert.deepEqual(migrated.doc, { ...(v3 as object), version: CURRENT_PROJECT_VERSION });
}

{
  const legacyAsset = {
    id: 'asset_v3_media',
    name: 'Legacy interview.mov',
    sourceFilename: 'Legacy interview.mov',
    originalFilePath: '/Users/editor/Legacy interview.mov',
    kind: 'video',
    src: '/media/uploads/legacy-interview.mov',
    durationInFrames: 90,
    sourceSize: 8_192,
    sourceModifiedAt: 123_456,
  };
  const legacyItem = {
    id: 'item_v3_media',
    track: 'track_tl_v3_media_1',
    startFrame: 0,
    durationInFrames: 90,
    name: legacyAsset.name,
    kind: 'video',
    src: legacyAsset.src,
    sourceAssetId: legacyAsset.id,
    sourceFilename: legacyAsset.sourceFilename,
    originalFilePath: legacyAsset.originalFilePath,
  };
  const legacyDoc = {
    version: 3,
    assets: [legacyAsset],
    mediaFolders: [],
    timelines: [{
      id: 'tl_v3_media',
      name: 'Legacy media',
      order: 0,
      fps: 30,
      width: 1920,
      height: 1080,
      selectedId: null,
      trackOrder: ['track_tl_v3_media_1'],
      tracks: { track_tl_v3_media_1: { kind: 'video' } },
      items: [legacyItem],
    }],
    activeTimelineId: 'tl_v3_media',
  };
  const migrated = runProjectMigrations(legacyDoc);
  assert.ok(migrated);
  const { sourceRevision: assetRevision, ...assetWithoutRevision } = migrated.doc.assets[0]!;
  const { sourceRevision: itemRevision, ...itemWithoutRevision } = migrated.doc.timelines[0]!.items[0]!;
  assert.deepEqual(assetWithoutRevision, legacyAsset, 'valid V3 asset data survives V4 migration unchanged');
  assert.deepEqual(itemWithoutRevision, legacyItem, 'valid V3 item data survives V4 migration unchanged');
  assert.ok(assetRevision);
  assert.equal(itemRevision, assetRevision, 'V4 derives one shared source revision without inventing a content hash');
  assert.equal(Object.hasOwn(migrated.doc.assets[0]!, 'sourceContentHash'), false);
  assert.equal(Object.hasOwn(migrated.doc.timelines[0]!.items[0]!, 'sourceContentHash'), false);
  assert.deepEqual(migrateProjectDoc(migrated.doc), migrated.doc, 'V3 media migration is idempotent');
}

{
  const legacyTimeline = {
    fps: 24,
    width: 1280,
    height: 720,
    selectedId: null,
    items: [],
  };
  assert.deepEqual(migrateProjectDoc(legacyTimeline), migrateProjectDoc(legacyTimeline),
    'pre-versioned single timelines migrate deterministically');
}

{
  assert.equal(migrateProjectDoc({ ...v3 as object, version: 99 }), null, 'future versions are not guessed');
  assert.equal(migrateProjectDoc({ version: 2, timelines: [], activeTimelineId: '' }), null);
  const validItem = (v3 as { timelines: Array<{ items: unknown[] }> }).timelines[0]!.items[0]!;
  const invalidItem = (patch: Record<string, unknown>) => ({
    ...(v3 as { timelines: Array<{ items: unknown[] }> }),
    timelines: [{
      ...(v3 as { timelines: Array<Record<string, unknown>> }).timelines[0],
      items: [{ ...(validItem as object), ...patch }],
    }],
  });
  assert.equal(migrateProjectDoc(invalidItem({ durationInFrames: Number.NaN })), null, 'NaN duration is rejected');
  assert.equal(migrateProjectDoc(invalidItem({ durationInFrames: -5 })), null, 'negative duration is rejected');
  assert.equal(migrateProjectDoc(invalidItem({ playbackRate: 0 })), null, 'zero playback rate is rejected');
  assert.equal(migrateProjectDoc(invalidItem({ volume: 50 })), null, 'out-of-range volume is rejected');
  assert.equal(migrateProjectDoc(invalidItem({ id: '' })), null, 'empty item ids are rejected');
}

// Runtime migration normalizes string source filenames and removes malformed
// values from every media-source shape while retaining desktop-only local paths.
{
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
}

// Portable project imports report and use the exact same migration chain.
{
  const progress: Array<[number, number]> = [];
  const parsed = parseProjectEnvelope(JSON.stringify({
    format: PROJECT_EXPORT_FORMAT,
    name: 'Legacy import',
    exportedAt: '2026-07-21T00:00:00.000Z',
    doc: v2,
    media: [],
  }), { onProgress: (event) => progress.push([event.fromVersion, event.toVersion]) });
  assert.ok('envelope' in parsed);
  if ('envelope' in parsed) assert.equal(parsed.envelope.doc.version, CURRENT_PROJECT_VERSION);
  assert.deepEqual(progress, [[2, 3], [3, 4]]);
}

// Cache migration is atomic: save only the completed chain; invalid bytes remain untouched.
{
  resetProjectStoreMemory();
  await kvSet('project:fixture-v1', v1);
  const progress: Array<[number, number]> = [];
  const loaded = await loadProject('fixture-v1', {
    onProgress: (event) => progress.push([event.fromVersion, event.toVersion]),
  });
  assert.equal(loaded?.version, CURRENT_PROJECT_VERSION);
  assert.deepEqual(progress, [[1, 2], [2, 3], [3, 4]]);
  assert.equal((await kvGet<{ version?: number }>('project:fixture-v1'))?.version, CURRENT_PROJECT_VERSION);

  const broken = { version: 2, timelines: [], activeTimelineId: '' };
  await kvSet('project:broken', broken);
  assert.equal(await loadProject('broken'), null);
  assert.deepEqual(await kvGet('project:broken'), broken, 'failed migration never overwrites source bytes');

  const brokenMidChain = {
    version: 1,
    timelines: [{ id: 'tl_broken', name: 'Broken', order: 0, fps: 30, width: 1, height: 1, items: [null] }],
    activeTimelineId: 'tl_broken',
  };
  await kvSet('project:broken-mid-chain', brokenMidChain);
  assert.equal(await loadProject('broken-mid-chain'), null);
  assert.deepEqual(await kvGet('project:broken-mid-chain'), brokenMidChain,
    'a later step failure never persists an intermediate version');
}

// Shared templates and named snapshots use the same chain and persist atomically.
{
  resetProjectStoreMemory();
  await kvSet('templates:all', [{
    id: 'template_legacy', name: 'Legacy template', createdAt: 1, doc: v1, assetIds: ['asset_video'],
  }]);
  assert.equal((await listTemplates())[0].doc.version, CURRENT_PROJECT_VERSION);
  const storedTemplates = await kvGet<Array<{ doc: { version?: number } }>>('templates:all');
  assert.equal(storedTemplates?.[0].doc.version, CURRENT_PROJECT_VERSION);

  resetProjectStoreMemory();
  const mixedLibrary = [
    { id: 'template_legacy', name: 'Legacy template', createdAt: 1, doc: v1, assetIds: [] },
    { id: 'broken', name: 'Broken template', createdAt: 2, doc: { version: 99 }, assetIds: [] },
  ];
  await kvSet('templates:all', mixedLibrary);
  assert.equal((await listTemplates()).length, 1, 'valid entries remain readable beside a corrupt entry');
  assert.deepEqual(await kvGet('templates:all'), mixedLibrary, 'partial library migration is never persisted');

  resetProjectStoreMemory();
  await kvSet('versions:project_legacy', [{ id: 'snapshot_legacy', name: 'Before', createdAt: 1, doc: v2 }]);
  assert.equal((await listVersions('project_legacy'))[0].doc.version, CURRENT_PROJECT_VERSION);
  const storedVersions = await kvGet<Array<{ doc: { version?: number } }>>('versions:project_legacy');
  assert.equal(storedVersions?.[0].doc.version, CURRENT_PROJECT_VERSION);
}

console.log('project migrations verification passed');
