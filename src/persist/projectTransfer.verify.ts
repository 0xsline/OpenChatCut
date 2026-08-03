import assert from 'node:assert/strict';
import { CURRENT_PROJECT_VERSION } from '../../shared/project-version';
import type { ProjectDoc } from '../editor/types';
import {
  createProject, resetProjectStoreMemory, saveChat, type PersistedChat, type ProjectMeta,
} from './projectStore';
import {
  getMediaBlob, mediaBlobStoreUsage, putMediaBlob, resetMediaBlobMemory,
} from './mediaBlobStore';
import {
  applyProjectImport,
  buildProjectExport,
  importProjectPackage,
  PROJECT_EXPORT_FORMAT,
  PROJECT_STREAM_FORMAT,
  type ProjectEnvelope,
} from './projectTransfer';

const doc: ProjectDoc = {
  version: CURRENT_PROJECT_VERSION,
  assets: [{
    id: 'asset_1',
    name: 'source.bin',
    kind: 'audio',
    src: '/media/uploads/source.bin',
    durationInFrames: 30,
  }],
  mediaFolders: [],
  timelines: [{
    id: 'timeline_1',
    name: 'Sequence 1',
    order: 0,
    fps: 30,
    width: 1920,
    height: 1080,
    tracks: { A1: { kind: 'audio' } },
    trackOrder: ['A1'],
    items: [{
      id: 'clip_1',
      track: 'A1',
      startFrame: 0,
      durationInFrames: 30,
      kind: 'audio',
      name: 'source',
      src: '/media/uploads/source.bin',
      denoisedSrc: '/media/uploads/source.bin',
    }],
    selectedId: null,
  }],
  activeTimelineId: 'timeline_1',
};

const importedMeta: ProjectMeta = { id: 'imported', name: 'Imported', updatedAt: 1 };
const manifest = `${JSON.stringify({
  format: PROJECT_STREAM_FORMAT,
  type: 'manifest',
  name: 'Stream import',
  exportedAt: '2026-07-31T00:00:00.000Z',
  doc,
})}\n`;

const hashSrc = async (value: string, extension = '.bin'): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `/media/uploads/sha256-${hex}${extension}`;
};

const mediaRows = (src: string, value: string, name = src.split('/').pop() ?? 'file.bin'): string[] => [
  `${JSON.stringify({ type: 'media-start', src, name, mime: 'application/octet-stream', bytes: value.length })}\n`,
  `${JSON.stringify({ type: 'media-chunk', data: Buffer.from(value).toString('base64') })}\n`,
  `${JSON.stringify({ type: 'media-end', src })}\n`,
];

const originalFetch = globalThis.fetch;
try {
  const uploads: string[] = [];
  const serverDeletes: string[] = [];
  const serverMedia = new Map<string, string>();
  const serverOwners = new Map<string, string>();
  const resetServerState = () => {
    uploads.length = 0;
    serverDeletes.length = 0;
    serverMedia.clear();
    serverOwners.clear();
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (url.pathname.startsWith('/media/uploads/')) {
      const body = serverMedia.get(url.pathname);
      return body === undefined
        ? new Response(null, { status: 404 })
        : new Response(method === 'HEAD' ? null : body, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
    }
    if (url.pathname === '/upload' && method === 'DELETE') {
      const src = `/media/uploads/${url.searchParams.get('name') ?? ''}`;
      const rollbackToken = url.searchParams.get('rollbackToken') ?? '';
      serverDeletes.push(src);
      if (serverOwners.get(src) === rollbackToken) {
        serverOwners.delete(src);
        serverMedia.delete(src);
      }
      return Response.json({ ok: true });
    }
    if (url.pathname !== '/upload' || method !== 'POST') return new Response(null, { status: 404 });
    assert.equal(url.searchParams.get('ifAbsent'), '1', 'project import always creates server media conditionally');
    const originalName = url.searchParams.get('name') ?? 'file.bin';
    const extension = originalName.match(/(\.[A-Za-z0-9]+)$/)?.[1] ?? '.bin';
    const src = `/media/uploads/${url.searchParams.get('assetId') ?? 'unknown'}${extension}`;
    const body = init?.body instanceof Blob ? await init.body.text() : '';
    uploads.push(src);
    if (serverMedia.has(src)) return Response.json({ path: src, created: false, existing: true });
    const rollbackToken = url.searchParams.get('rollbackToken') ?? '';
    serverMedia.set(src, body);
    serverOwners.set(src, rollbackToken);
    return Response.json({ path: src, created: true, rollbackToken });
  };

  // An attacker-controlled package src never selects the victim's IDB/server
  // identity. Every ProjectDoc reference is rewritten to decoded-byte identity.
  {
    resetMediaBlobMemory();
    resetServerState();
    const victimSrc = '/media/uploads/source.bin';
    serverMedia.set(victimSrc, 'victim-server');
    await putMediaBlob(victimSrc, new Blob(['victim-idb']), {
      name: 'source.bin',
      mime: 'application/octet-stream',
    });
    let publishedDoc: ProjectDoc | undefined;
    const imported = await importProjectPackage(new Blob([manifest, ...mediaRows(victimSrc, 'abc')]), {
      publish: async (staged) => {
        publishedDoc = staged.doc;
        return importedMeta;
      },
    });
    const isolatedSrc = await hashSrc('abc');
    assert.equal(await (await getMediaBlob(victimSrc))?.blob.text(), 'victim-idb');
    assert.equal(serverMedia.get(victimSrc), 'victim-server');
    assert.equal(doc.assets[0]?.src, victimSrc, 'import rewriting never mutates the source or another project document');
    assert.equal(publishedDoc?.assets[0]?.src, isolatedSrc);
    assert.equal(publishedDoc?.timelines[0]?.items[0]?.src, isolatedSrc);
    assert.equal(publishedDoc?.timelines[0]?.items[0]?.denoisedSrc, isolatedSrc);
    assert.equal(await (await getMediaBlob(isolatedSrc))?.blob.text(), 'abc');
    assert.equal(serverMedia.get(isolatedSrc), 'abc');
    assert.deepEqual(imported.mediaMissing, []);
  }

  // A corrupt tail after decoded media discards the isolated staging namespace
  // without touching either the victim identity or a global safe destination.
  {
    resetMediaBlobMemory();
    resetServerState();
    const victimSrc = '/media/uploads/source.bin';
    serverMedia.set(victimSrc, 'victim-server');
    await putMediaBlob(victimSrc, new Blob(['victim-idb']), {
      name: 'source.bin',
      mime: 'application/octet-stream',
    });
    const isolatedSrc = await hashSrc('abc');
    await assert.rejects(() => importProjectPackage(new Blob([
      manifest,
      ...mediaRows(victimSrc, 'abc'),
      `${JSON.stringify({ type: 'corrupt-tail' })}\n`,
    ])), /未知记录/);
    assert.equal(await (await getMediaBlob(victimSrc))?.blob.text(), 'victim-idb');
    assert.equal(serverMedia.get(victimSrc), 'victim-server');
    assert.equal(await getMediaBlob(isolatedSrc), undefined);
    assert.equal(serverMedia.has(isolatedSrc), false);
    assert.equal((await mediaBlobStoreUsage()).records, 1);
  }

  // Equal cryptographic content safely deduplicates distinct package identities.
  {
    resetMediaBlobMemory();
    resetServerState();
    const dedupeDoc = structuredClone(doc);
    dedupeDoc.assets.push({ ...dedupeDoc.assets[0]!, id: 'asset_2', src: '/media/uploads/second.bin' });
    const dedupeManifest = `${JSON.stringify({
      format: PROJECT_STREAM_FORMAT,
      type: 'manifest',
      name: 'Dedupe import',
      exportedAt: '',
      doc: dedupeDoc,
    })}\n`;
    let publishedDoc: ProjectDoc | undefined;
    await importProjectPackage(new Blob([
      dedupeManifest,
      ...mediaRows('/media/uploads/source.bin', 'same'),
      ...mediaRows('/media/uploads/second.bin', 'same'),
    ]), {
      publish: async (staged) => {
        publishedDoc = staged.doc;
        return importedMeta;
      },
    });
    const sharedSrc = await hashSrc('same');
    assert.equal(publishedDoc?.assets[0]?.src, sharedSrc);
    assert.equal(publishedDoc?.assets[1]?.src, sharedSrc);
    assert.deepEqual(uploads, [sharedSrc], 'same bytes publish only one global object');
    assert.equal((await mediaBlobStoreUsage()).records, 1);
  }

  // A pre-existing content-addressed object is reused only after both IDB and
  // server bytes hash equal to the package bytes.
  {
    resetMediaBlobMemory();
    resetServerState();
    const sharedSrc = await hashSrc('same');
    serverMedia.set(sharedSrc, 'same');
    await putMediaBlob(sharedSrc, new Blob(['same']), { name: 'shared.bin', mime: 'application/octet-stream' });
    await importProjectPackage(new Blob([manifest, ...mediaRows('/media/uploads/source.bin', 'same')]), {
      publish: async (staged) => {
        assert.equal(staged.doc.assets[0]?.src, sharedSrc);
        return importedMeta;
      },
    });
    assert.deepEqual(uploads, []);
    assert.equal(await (await getMediaBlob(sharedSrc))?.blob.text(), 'same');
    assert.equal(serverMedia.get(sharedSrc), 'same');
  }

  // A forged occupant at the expected content key forces an import-scoped name;
  // it is never overwritten merely because the package claimed another src.
  {
    resetMediaBlobMemory();
    resetServerState();
    const poisonedContentSrc = await hashSrc('abc');
    serverMedia.set(poisonedContentSrc, 'different-server');
    await putMediaBlob(poisonedContentSrc, new Blob(['different-idb']), {
      name: 'poisoned.bin',
      mime: 'application/octet-stream',
    });
    let isolatedSrc = '';
    await importProjectPackage(new Blob([manifest, ...mediaRows('/media/uploads/source.bin', 'abc')]), {
      publish: async (staged) => {
        isolatedSrc = staged.doc.assets[0]?.src ?? '';
        return importedMeta;
      },
    });
    assert.match(isolatedSrc, /^\/media\/uploads\/import-[A-Za-z0-9-]+-0-[a-f0-9]{24}\.bin$/);
    assert.notEqual(isolatedSrc, poisonedContentSrc);
    assert.equal(await (await getMediaBlob(poisonedContentSrc))?.blob.text(), 'different-idb');
    assert.equal(serverMedia.get(poisonedContentSrc), 'different-server');
    assert.equal(await (await getMediaBlob(isolatedSrc))?.blob.text(), 'abc');
  }

  // Project publication failure rolls back the isolated IDB/server objects and
  // staging namespace while leaving the attacker-named victim identity intact.
  {
    resetMediaBlobMemory();
    resetServerState();
    const victimSrc = '/media/uploads/source.bin';
    serverMedia.set(victimSrc, 'victim-server');
    await putMediaBlob(victimSrc, new Blob(['victim-idb']), {
      name: 'source.bin',
      mime: 'application/octet-stream',
    });
    const isolatedSrc = await hashSrc('rollback');
    await assert.rejects(() => importProjectPackage(
      new Blob([manifest, ...mediaRows(victimSrc, 'rollback')]),
      { publish: async () => { throw new Error('project publish failure'); } },
    ), /project publish failure/);
    assert.equal(await (await getMediaBlob(victimSrc))?.blob.text(), 'victim-idb');
    assert.equal(serverMedia.get(victimSrc), 'victim-server');
    assert.equal(await getMediaBlob(isolatedSrc), undefined);
    assert.equal(serverMedia.has(isolatedSrc), false);
    assert.deepEqual(serverDeletes, [isolatedSrc]);
    assert.equal((await mediaBlobStoreUsage()).records, 1, 'rollback removes all import temporary records');
  }

  // Legacy JSON packages use the same isolated transaction and rollback path.
  {
    resetMediaBlobMemory();
    resetServerState();
    const envelope: ProjectEnvelope = {
      format: PROJECT_EXPORT_FORMAT,
      name: 'Legacy import',
      exportedAt: '',
      doc,
      media: [{
        src: '/media/uploads/source.bin',
        name: 'source.bin',
        mime: 'application/octet-stream',
        bytes: 3,
        dataBase64: 'YWJj',
      }],
    };
    const isolatedSrc = await hashSrc('abc');
    await assert.rejects(() => applyProjectImport(envelope, {
      publish: async (staged) => {
        assert.equal(staged.doc.assets[0]?.src, isolatedSrc);
        throw new Error('legacy project publish failure');
      },
    }), /legacy project publish failure/);
    assert.equal(await getMediaBlob('/media/uploads/source.bin'), undefined);
    assert.equal(await getMediaBlob(isolatedSrc), undefined);
    assert.equal(serverMedia.has(isolatedSrc), false);
    assert.equal((await mediaBlobStoreUsage()).records, 0);
  }
} finally {
  globalThis.fetch = originalFetch;
  resetMediaBlobMemory();
}

// Current exports are record streams: the manifest contains ProjectDoc only;
// media bytes follow in bounded chunk records rather than one in-memory media[].
{
  resetProjectStoreMemory();
  resetMediaBlobMemory();
  const originalFilePath = '/Users/private-editor/旅行/源文件.bin';
  const exportDoc = structuredClone(doc);
  exportDoc.assets[0] = {
    ...exportDoc.assets[0]!,
    sourceFilename: '源文件.bin',
    originalFilePath,
  };
  const sourceItem = {
    ...exportDoc.timelines[0]!.items[0]!,
    sourceFilename: '源文件.bin',
    originalFilePath,
  };
  exportDoc.timelines[0]!.items[0] = sourceItem;
  exportDoc.timelines[0]!.multicamGroups = [{
    id: 'group_1',
    referenceAngleId: 'angle_1',
    masterAngleId: 'angle_1',
    syncMethod: 'audio',
    angles: [
      {
        id: 'angle_1',
        itemId: sourceItem.id,
        source: { ...sourceItem },
        label: 'Source',
        offsetFrames: 0,
        confidence: 1,
      },
      {
        id: 'angle_2',
        itemId: sourceItem.id,
        source: { ...sourceItem },
        label: 'Source backup',
        offsetFrames: 0,
        confidence: 1,
      },
    ],
    evidence: [
      { angleId: 'angle_1', method: 'audio', confidence: 1, offsetFrames: 0 },
      { angleId: 'angle_2', method: 'audio', confidence: 1, offsetFrames: 0 },
    ],
    decisions: [],
  }];
  const project = await createProject('Stream export', exportDoc);
  const exportChat: PersistedChat = {
    messages: [],
    llm: [],
    changeLog: [{
      id: 'change_1',
      createdAt: 1,
      summary: 'Imported source',
      operations: [],
      beforeDoc: exportDoc,
      afterRevision: 'after',
      rollbackable: true,
    }],
  };
  await saveChat(project.id, exportChat);
  await putMediaBlob('/media/uploads/source.bin', new Blob(['abc'], { type: 'application/octet-stream' }), {
    name: 'source.bin',
    mime: 'application/octet-stream',
  });
  const exported = await buildProjectExport(project.id, project.name);
  const lines = (await exported.blob.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(lines[0]?.format, PROJECT_STREAM_FORMAT);
  assert.equal(lines[0]?.type, 'manifest');
  assert.equal('media' in (lines[0] ?? {}), false, 'manifest never aggregates media base64 beside ProjectDoc');
  assert.equal(JSON.stringify(lines[0]).includes(originalFilePath), false, 'portable manifests never expose desktop absolute paths');
  const manifestDoc = lines[0]?.doc as ProjectDoc;
  assert.equal(manifestDoc.assets[0]?.sourceFilename, '源文件.bin', 'portable original filenames remain available');
  assert.equal(manifestDoc.assets[0]?.originalFilePath, undefined);
  assert.equal(manifestDoc.timelines[0]?.items[0]?.sourceFilename, '源文件.bin');
  assert.equal(manifestDoc.timelines[0]?.items[0]?.originalFilePath, undefined);
  assert.equal(manifestDoc.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.originalFilePath, undefined);
  assert.equal(manifestDoc.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.sourceFilename, '源文件.bin');
  const manifestChat = lines[0]?.chat as PersistedChat;
  const manifestBeforeDoc = (manifestChat.changeLog?.[0] as { beforeDoc?: ProjectDoc } | undefined)?.beforeDoc;
  assert.ok(manifestBeforeDoc);
  assert.equal(manifestBeforeDoc.assets[0]?.originalFilePath, undefined);
  assert.equal(manifestBeforeDoc.timelines[0]?.items[0]?.originalFilePath, undefined);
  assert.equal(manifestBeforeDoc.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.originalFilePath, undefined);
  assert.equal(manifestBeforeDoc.assets[0]?.sourceFilename, '源文件.bin');
  assert.equal(exportDoc.assets[0]?.originalFilePath, originalFilePath, 'export sanitization never mutates the live document');
  const liveBeforeDoc = (exportChat.changeLog?.[0] as { beforeDoc?: ProjectDoc } | undefined)?.beforeDoc;
  assert.ok(liveBeforeDoc);
  assert.equal(
    liveBeforeDoc.assets[0]?.originalFilePath,
    originalFilePath,
    'chat export sanitization never mutates the saved snapshot',
  );
  assert.deepEqual(lines.slice(1).map((line) => line.type), ['media-start', 'media-chunk', 'media-end']);
}

// Both legacy and streamed portable imports sanitize the migrated document and
// nested rollback snapshots before the project publish boundary.
{
  resetMediaBlobMemory();
  const originalFilePath = '/Users/attacker/private/source.bin';
  const maliciousDoc = structuredClone(doc);
  maliciousDoc.assets[0] = {
    ...maliciousDoc.assets[0]!,
    sourceFilename: 'source.bin',
    originalFilePath,
  };
  maliciousDoc.timelines[0]!.items[0] = {
    ...maliciousDoc.timelines[0]!.items[0]!,
    sourceFilename: 'source.bin',
    originalFilePath,
  };
  Object.assign(maliciousDoc.timelines[0]!.items[0]!, { sourceFilename: ['private.mov'] });
  const maliciousItem = maliciousDoc.timelines[0]!.items[0]!;
  maliciousDoc.timelines[0]!.multicamGroups = [{
    id: 'group_untrusted',
    referenceAngleId: 'angle_untrusted_1',
    masterAngleId: 'angle_untrusted_1',
    syncMethod: 'audio',
    angles: [
      {
        id: 'angle_untrusted_1',
        itemId: maliciousItem.id,
        source: { ...maliciousItem },
        label: 'Untrusted',
        offsetFrames: 0,
        confidence: 1,
      },
      {
        id: 'angle_untrusted_2',
        itemId: maliciousItem.id,
        source: { ...maliciousItem },
        label: 'Untrusted backup',
        offsetFrames: 0,
        confidence: 1,
      },
    ],
    evidence: [
      { angleId: 'angle_untrusted_1', method: 'audio', confidence: 1, offsetFrames: 0 },
      { angleId: 'angle_untrusted_2', method: 'audio', confidence: 1, offsetFrames: 0 },
    ],
    decisions: [],
  }];
  const maliciousChat: PersistedChat = {
    messages: [],
    llm: [],
    changeLog: [{
      id: 'change_untrusted',
      createdAt: 1,
      summary: 'Untrusted snapshot',
      operations: [],
      beforeDoc: maliciousDoc,
      afterRevision: 'after',
      rollbackable: true,
    }],
  };
  const assertPublishedPortable = async (staged: {
    doc: ProjectDoc;
    chat?: PersistedChat;
  }): Promise<ProjectMeta> => {
    assert.equal(staged.doc.assets[0]?.originalFilePath, undefined);
    assert.equal(staged.doc.timelines[0]?.items[0]?.originalFilePath, undefined);
    assert.equal(staged.doc.timelines[0]?.items[0]?.sourceFilename, undefined);
    assert.equal(staged.doc.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.originalFilePath, undefined);
    assert.equal(staged.doc.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.sourceFilename, undefined);
    const beforeDoc = (staged.chat?.changeLog?.[0] as { beforeDoc?: ProjectDoc } | undefined)?.beforeDoc;
    assert.ok(beforeDoc);
    assert.equal(beforeDoc.assets[0]?.originalFilePath, undefined);
    assert.equal(beforeDoc.timelines[0]?.items[0]?.originalFilePath, undefined);
    assert.equal(beforeDoc.timelines[0]?.items[0]?.sourceFilename, undefined);
    assert.equal(beforeDoc.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.originalFilePath, undefined);
    assert.equal(beforeDoc.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.sourceFilename, undefined);
    assert.equal(beforeDoc.assets[0]?.sourceFilename, 'source.bin');
    return importedMeta;
  };
  await importProjectPackage(new Blob([JSON.stringify({
    format: PROJECT_EXPORT_FORMAT,
    name: 'Untrusted v1',
    exportedAt: '',
    doc: maliciousDoc,
    chat: maliciousChat,
    media: [],
  })]), { publish: assertPublishedPortable });
  await importProjectPackage(new Blob([`${JSON.stringify({
    format: PROJECT_STREAM_FORMAT,
    type: 'manifest',
    name: 'Untrusted v2',
    exportedAt: '',
    doc: maliciousDoc,
    chat: maliciousChat,
  })}\n`]), { publish: assertPublishedPortable });
  assert.equal(maliciousDoc.assets[0]?.originalFilePath, originalFilePath, 'import sanitization does not mutate parsed input');
  assert.equal(
    maliciousDoc.timelines[0]?.multicamGroups?.[0]?.angles[0]?.source.originalFilePath,
    originalFilePath,
    'import sanitization leaves nested live sources untouched',
  );
}

console.log('projectTransfer.verify: isolated media identities, hash dedupe, and rollback contracts OK');
