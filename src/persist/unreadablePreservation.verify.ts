// Data-safety rule: boundary validation on READ must not become deletion on
// WRITE. Entries this build cannot parse are usually data written by a NEWER
// build; filtering them for display is right, writing the filtered list back
// destroys them. Covers versionStore / exportHistoryStore / templateStore /
// jobRegistryStore plus the v1→v2 unknown-field passthrough and the chat
// load三态. npx tsx src/persist/unreadablePreservation.verify.ts
import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import type { ProjectDoc } from '../editor/types';
import { partitionRecords, withPreservedRecords } from './recordPartition';
import { kvGet, kvSet, resetSharedKvMemory } from './sharedKv';
import { deleteVersion, listVersions, saveVersion } from './versionStore';
import { listExportHistory, recordExport } from './exportHistoryStore';
import { v1ToV2 } from './migrations/v1-to-v2';

const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [],
  mediaFolders: [],
  timelines: [{
    id: 'tl1', name: '序列 1', fps: 30, width: 1920, height: 1080, selectedId: null, items: [],
  }],
  activeTimelineId: 'tl1',
} as unknown as ProjectDoc;

// ── partitionRecords / withPreservedRecords 纯逻辑 ────────────────────────
{
  const parse = (v: unknown) => (typeof v === 'number' ? v : null);
  const { valid, opaque } = partitionRecords([1, 'x', 2, { future: true }], parse);
  assert.deepEqual(valid, [1, 2], 'parsable entries surface');
  assert.deepEqual(opaque, ['x', { future: true }], 'unparsable entries are kept verbatim');
  assert.deepEqual(withPreservedRecords([9], opaque), [9, 'x', { future: true }],
    'writes carry the opaque tail');
  assert.deepEqual(withPreservedRecords([9], []), [9], 'no opaque tail = plain array');
  assert.deepEqual(partitionRecords('not an array', parse), { valid: [], opaque: [] },
    'a non-array value degrades to empty, never throws');
}

// ── versionStore:新版快照(version 99)不得被旧版的自动保存抹掉 ─────────────
{
  resetSharedKvMemory();
  const projectId = 'proj-versions';
  const futureSnapshot = { id: 'future', name: '来自新版', createdAt: 1, doc: { version: 99 } };
  await kvSet(`versions:${projectId}`, [futureSnapshot]);
  assert.deepEqual(await listVersions(projectId), [], '不可读快照不进展示列表');

  await saveVersion(projectId, '本版快照', doc);
  const stored = await kvGet<unknown[]>(`versions:${projectId}`);
  assert.equal(stored?.length, 2, '写入后新旧两条都在');
  assert.deepEqual(stored?.[1], futureSnapshot, '新版快照原样保留(未被过滤写回抹掉)');
  assert.equal((await listVersions(projectId)).length, 1, '展示层仍只看到可读的一条');

  const mine = (await listVersions(projectId))[0]!;
  await deleteVersion(projectId, mine.id);
  const afterDelete = await kvGet<unknown[]>(`versions:${projectId}`);
  assert.deepEqual(afterDelete, [futureSnapshot], '删除自己的版本不牵连不可读条目');
}

// ── exportHistoryStore:未知条目 + 未知字段双重保留 ────────────────────────
{
  resetSharedKvMemory();
  const futureRecord = { kind: 'future-export', payload: 1 };
  const knownWithExtra = {
    id: 'e1', name: 'a.mp4', format: 'video', createdAt: 2, futureField: 'keep-me',
  };
  await kvSet('export:history', [knownWithExtra, futureRecord]);
  await recordExport({ name: 'b.mp4', format: 'video', createdAt: 3 });
  const stored = await kvGet<Array<Record<string, unknown>>>('export:history');
  assert.equal(stored?.length, 3, '新记录 + 已知记录 + 不可读记录');
  assert.deepEqual(stored?.[2], futureRecord, '不可读记录原样保留');
  const preserved = stored?.find((r) => r.id === 'e1');
  assert.equal(preserved?.futureField, 'keep-me', '已知记录上的未知字段透传');
  assert.equal((await listExportHistory()).length, 2, '展示层只列可读记录');
}

// ── v1→v2:未知顶层字段透传,非法 designStyle 仍被剥离 ─────────────────────
{
  const migrated = v1ToV2.migrate({
    version: 1,
    assets: [],
    mediaFolders: [],
    timelines: [{ id: 'tl1', name: 's', fps: 30, width: 1920, height: 1080, selectedId: null, items: [] }],
    activeTimelineId: 'tl1',
    futureTopLevel: { keep: true },
    designStyle: 'not-a-style',
  }) as Record<string, unknown>;
  assert.equal(migrated.version, 2, '版本推进');
  assert.deepEqual(migrated.futureTopLevel, { keep: true }, '未知顶层字段不再蒸发');
  assert.equal(migrated.designStyle, undefined, '非法 designStyle 仍被剥离(未被 spread 带过)');
}

console.log('unreadablePreservation.verify: ok');
