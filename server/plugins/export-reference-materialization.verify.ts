import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { materializeServerExportMedia } from './export-media-plan.ts';

const root = await mkdtemp(join(tmpdir(), 'openchatcut-export-reference-'));
const uploads = join(root, 'uploads');
const publicDirectory = join(root, 'public');
const source = join(root, 'external drive', 'camera original.mp4');

try {
  await mkdir(join(root, 'external drive'), { recursive: true });
  await mkdir(uploads, { recursive: true });
  await mkdir(publicDirectory, { recursive: true });
  await writeFile(source, 'referenced video');
  const project = {
    items: [{ id: 'clip', kind: 'video', src: '/media/uploads/reference.mp4' }],
  };
  const materialized = await materializeServerExportMedia(project, {
    uploadDirectory: uploads,
    publicDirectory,
    resolveUpload: (name) => name === 'reference.mp4' ? source : null,
    resolveUploadReference: (name) => name === 'reference.mp4' ? source : null,
    hydrateUpload: async () => null,
  });
  const renderSource = materialized.snapshot.items[0]!.src;
  assert.match(renderSource, /^\/media\/uploads\/export-references\//);
  assert.equal(
    await readFile(join(uploads, decodeURIComponent(renderSource.slice('/media/uploads/'.length))), 'utf8'),
    'referenced video',
    'the renderer must read the external file through a temporary directory link',
  );
  const [linkPath] = materialized.localPaths;
  assert.ok(linkPath);
  await materialized.cleanup();
  await assert.rejects(access(linkPath), { code: 'ENOENT' });
  assert.equal(await readFile(source, 'utf8'), 'referenced video', 'export cleanup must preserve the source');
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write('export-reference-materialization.verify: reference render mapping and cleanup passed\n');
