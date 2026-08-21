import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../../shared/project-version';
import { loadProject, migrateProjectDoc, resetProjectStoreMemory } from '../projectStore';
import { parseProjectEnvelope, PROJECT_EXPORT_FORMAT } from '../projectTransfer';
import { kvGet, kvSet } from '../sharedKv';
import { listTemplates } from '../templateStore';
import { listVersions } from '../versionStore';
import { runProjectMigrations } from './index';
import { v1, v2, v3, v3V019Compatible, v4, v5, v6 } from './migrations.verify.fixtures';
import { verifySourceMetadataMigration } from './migrations.verify.source-metadata';


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
  assert.deepEqual(migrated.appliedSteps, ['v1-to-v2', 'v2-to-v3']);
  assert.deepEqual(progress, [[1, 2, 1, 2], [2, 3, 2, 2]]);
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
  assert.deepEqual(migrated.appliedSteps, ['v2-to-v3']);
  assert.equal(migrated.doc.timelines[0].items[0].track, 'track_tl_fixture_2');
}

{
  const current = migrateProjectDoc(v3);
  assert.ok(current);
  const migrated = migrateProjectDoc({
    ...current,
    assets: [
      ...current.assets,
      { id: 'doc', name: 'script.md', kind: 'document', src: '/media/uploads/script.md', durationInFrames: 1 },
      { id: 'file', name: 'design.psd', kind: 'file', src: '/media/uploads/design.psd', durationInFrames: 1 },
    ],
  });
  assert.deepEqual(migrated?.assets.slice(-2).map((asset) => asset.kind), ['document', 'file']);
}

{
  const progress: Array<[number, number]> = [];
  const migrated = runProjectMigrations(v3, {
    onProgress: (event) => progress.push([event.fromVersion, event.toVersion]),
  });
  assert.ok(migrated);
  assert.deepEqual(migrated.appliedSteps, []);
  assert.deepEqual(progress, [], 'current V3 documents never show migration progress');
  assert.deepEqual(migrated.doc, v3);
}
// V0.1.9 accepted V3 by validating the then-required core shape and ignored
// additional object properties. This faithful reader proves new optional fields
// remain readable without a schema-label bump.
const parseWithV019Reader = (value: unknown): object | null => {
  if (!value || typeof value !== 'object') return null;
  const project = value as {
    version?: unknown;
    assets?: unknown;
    mediaFolders?: unknown;
    timelines?: unknown;
    activeTimelineId?: unknown;
  };
  if (project.version !== 3
    || !Array.isArray(project.assets)
    || !Array.isArray(project.mediaFolders)
    || !Array.isArray(project.timelines)
    || project.timelines.length === 0
    || typeof project.activeTimelineId !== 'string') return null;
  const timelinesValid = project.timelines.every((timeline) => {
    if (!timeline || typeof timeline !== 'object') return false;
    const legacy = timeline as { fps?: unknown; items?: unknown };
    return typeof legacy.fps === 'number'
      && Number.isFinite(legacy.fps)
      && legacy.fps > 0
      && Array.isArray(legacy.items)
      && legacy.items.every((item) => {
        if (!item || typeof item !== 'object') return false;
        const oldItem = item as Record<string, unknown>;
        return typeof oldItem.id === 'string'
          && typeof oldItem.track === 'string'
          && typeof oldItem.name === 'string'
          && typeof oldItem.kind === 'string'
          && typeof oldItem.startFrame === 'number'
          && typeof oldItem.durationInFrames === 'number';
      });
  });
  return timelinesValid ? value : null;
};

{
  assert.equal(parseWithV019Reader(v3V019Compatible), v3V019Compatible);
  const migrated = runProjectMigrations(v3V019Compatible);
  assert.ok(migrated);
  assert.equal(parseWithV019Reader(migrated.doc), migrated.doc);
  const compatDoc = migrated.doc as unknown as Record<string, unknown>;
  const compatTimeline = migrated.doc.timelines[0] as unknown as Record<string, unknown>;
  const compatAsset = migrated.doc.assets[0] as unknown as Record<string, unknown>;
  const compatItem = migrated.doc.timelines[0]?.items[0] as unknown as Record<string, unknown>;
  const compatTrack = migrated.doc.timelines[0]?.tracks?.track_v3_compat as unknown as Record<string, unknown>;
  assert.deepEqual(compatDoc.topLevelSentinel, { preserve: true });
  assert.deepEqual(compatTimeline.timelineSentinel, { preserve: true });
  assert.deepEqual(compatAsset.assetSentinel, { preserve: true });
  assert.deepEqual(compatItem.itemSentinel, { preserve: true });
  assert.deepEqual(compatTrack.trackSentinel, { preserve: true });
  assert.equal(compatItem.backgroundFill, true);
  assert.equal(compatItem.backgroundFillStrength, 75);
  assert.equal(compatAsset.sourceContentHash, 'a'.repeat(64));
  assert.deepEqual(migrateProjectDoc(migrated.doc), migrated.doc);
}


const withUnknownSentinels = (source: unknown, version: number): unknown => {
  const project = source as { timelines: Array<Record<string, unknown>> };
  return {
    ...(project as object),
    version,
    topLevelSentinel: { preserve: true },
    timelines: project.timelines.map((timeline) => ({
      ...timeline,
      timelineSentinel: { preserve: true },
      items: (timeline.items as Array<Record<string, unknown>>).map((item) => ({
        ...item,
        itemSentinel: { preserve: true },
      })),
    })),
  };
};

for (const [version, source] of [[4, v4], [5, v5], [6, v6], [7, v6]] as const) {
  const input = withUnknownSentinels(source, version);
  const sourceSnapshot = JSON.stringify(input);
  const migrated = runProjectMigrations(input);
  assert.ok(migrated);
  assert.deepEqual(migrated.appliedSteps, [`dev-v${version}-to-v3`]);
  assert.equal(migrated.doc.version, CURRENT_PROJECT_VERSION);
  assert.deepEqual((migrated.doc as unknown as Record<string, unknown>).topLevelSentinel, { preserve: true });
  assert.deepEqual(
    (migrated.doc.timelines[0] as unknown as Record<string, unknown>).timelineSentinel,
    { preserve: true },
  );
  assert.deepEqual(
    (migrated.doc.timelines[0]!.items[0] as unknown as Record<string, unknown>).itemSentinel,
    { preserve: true },
  );
  assert.equal(JSON.stringify(input), sourceSnapshot, `development V${version} collapse never mutates source bytes`);
  assert.deepEqual(migrateProjectDoc(migrated.doc), migrated.doc, `development V${version} collapse is idempotent`);
}

{
  const migratedV4 = runProjectMigrations(v4);
  const migratedV5 = runProjectMigrations(v5);
  const migratedV6 = runProjectMigrations(v6);
  assert.ok(migratedV4 && migratedV5 && migratedV6);
  assert.equal(migratedV4.doc.timelines[0]?.items[0]?.backgroundFill, undefined);
  assert.equal(migratedV5.doc.timelines[0]?.items[0]?.backgroundFill, true);
  assert.equal(migratedV5.doc.timelines[0]?.items[0]?.backgroundFillStrength, undefined);
  const v6Clip = migratedV6.doc.timelines[0]?.items[0];
  assert.equal(v6Clip?.backgroundFillStrength, 75, 'development preset collapse keeps the exact strength');
  assert.equal(Object.hasOwn(v6Clip ?? {}, 'backgroundFillPreset'), false);
}
for (const [preset, expectedStrength] of [
  ['soft', 25],
  ['medium', undefined],
  ['strong', 75],
  ['maximum', 100],
] as const) {
  const source = v6 as { timelines: Array<{ items: Array<Record<string, unknown>> }> };
  const input = {
    ...source,
    version: 6,
    timelines: source.timelines.map((timeline) => ({
      ...timeline,
      items: timeline.items.map((item) => ({ ...item, backgroundFillPreset: preset })),
    })),
  };
  const migrated = runProjectMigrations(input);
  assert.ok(migrated);
  const item = migrated.doc.timelines[0]?.items[0];
  assert.equal(item?.backgroundFillStrength, expectedStrength);
  assert.equal(Object.hasOwn(item ?? {}, 'backgroundFillPreset'), false);
}

{
  const source = v6 as { timelines: Array<{ items: Array<Record<string, unknown>> }> };
  const input = {
    ...source,
    version: 7,
    timelines: source.timelines.map((timeline) => ({
      ...timeline,
      items: timeline.items.map((item) => ({ ...item, backgroundFill: false, backgroundFillPreset: 'maximum' })),
    })),
  };
  const migrated = runProjectMigrations(input);
  assert.ok(migrated);
  const item = migrated.doc.timelines[0]?.items[0];
  assert.equal(item?.backgroundFillStrength, undefined);
  assert.equal(Object.hasOwn(item ?? {}, 'backgroundFillPreset'), false);
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
  assert.deepEqual(assetWithoutRevision, legacyAsset, 'valid V3 asset data survives normalization unchanged');
  assert.deepEqual(itemWithoutRevision, legacyItem, 'valid V3 item data survives normalization unchanged');
  assert.ok(assetRevision);
  assert.equal(itemRevision, assetRevision, 'normalization derives one shared source revision without inventing a content hash');
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

await verifySourceMetadataMigration();

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
  assert.deepEqual(progress, [[2, 3]]);
}

// Project reads normalize in memory without eagerly rewriting stored bytes.
{
  resetProjectStoreMemory();
  await kvSet('project:fixture-v1', v1);
  const progress: Array<[number, number]> = [];
  const loaded = await loadProject('fixture-v1', {
    onProgress: (event) => progress.push([event.fromVersion, event.toVersion]),
  });
  assert.equal(loaded?.version, CURRENT_PROJECT_VERSION);
  assert.deepEqual(progress, [[1, 2], [2, 3]]);
  assert.deepEqual(await kvGet('project:fixture-v1'), v1, 'successful read migration leaves source bytes untouched');

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

// Shared templates still persist complete-library migration atomically.
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
  const storedLegacyVersions = [{ id: 'snapshot_legacy', name: 'Before', createdAt: 1, doc: v2 }];
  await kvSet('versions:project_legacy', storedLegacyVersions);
  assert.equal((await listVersions('project_legacy'))[0].doc.version, CURRENT_PROJECT_VERSION);
  assert.deepEqual(
    await kvGet('versions:project_legacy'),
    storedLegacyVersions,
    'listing versions normalizes in memory without rewriting stored snapshots',
  );
}

console.log('project migrations verification passed');
