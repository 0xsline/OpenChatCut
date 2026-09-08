// Run: npx tsx server/plugins/skill-install.verify.ts
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { seedKeystore } from '../keystore.ts';
import { installGitHubSkill } from './skill-install.ts';
import {
  MAX_FILE_BYTES, MAX_TOTAL_BYTES, publishSkillFiles, stageCloneSkillFiles, stageSkillFile,
} from './skill-install-files.ts';

const root = await mkdtemp(join(tmpdir(), 'occ-skill-install-check-'));
const installed = join(root, 'installed');
const originalFetch = globalThis.fetch;
const skill = '---\nname: checked-skill\n---\n# Checked skill\n';
const contents = [Buffer.from(skill), Buffer.from([0, 1, 255]), Buffer.alloc(0)];
const paths = ['SKILL.md', 'assets/example.bin', 'references/empty.txt'];
const tree = paths.map((path, index) => ({
  path, type: 'blob', mode: '100644', size: contents[index]!.length,
  sha: String(index).repeat(40), url: 'https://untrusted.example/never-requested',
}));
let blobRequests = 0;
let fixtureTree = tree;
let failBlob = -1;

function mockApi(): void {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith('https://api.github.com/repos/fixtures/skill/git/'));
    if (url.includes('/trees/')) return Response.json({ tree: fixtureTree });
    blobRequests += 1;
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/vnd.github.raw+json');
    const index = Number(url.slice(url.lastIndexOf('/') + 1)[0]);
    if (index === failBlob) return new Response('fixture failure', { status: 500 });
    return new Response(new Uint8Array(contents[index]!));
  };
}

async function rejectsTree(entries: typeof tree, message: RegExp): Promise<void> {
  fixtureTree = entries;
  blobRequests = 0;
  await assert.rejects(installGitHubSkill('fixtures/skill'), message);
  assert.equal(blobRequests, 0, 'invalid metadata must fail before downloading any file');
  fixtureTree = tree;
}

async function checkCloneBoundaries(): Promise<void> {
  const source = join(root, 'clone');
  const stage = join(root, 'clone-stage');
  const outside = join(root, 'outside.txt');
  await mkdir(source);
  await mkdir(stage);
  await writeFile(outside, 'outside fixture');
  await symlink(outside, join(source, 'SKILL.md'));
  await assert.rejects(stageCloneSkillFiles(source, stage), /symbolic links/);
  assert.deepEqual(await readdir(stage), []);
  await rm(join(source, 'SKILL.md'));
  await writeFile(join(source, 'SKILL.md'), skill);
  await symlink(root, join(source, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(stageCloneSkillFiles(source, stage), /symbolic links/);
  await rm(join(source, 'references'));
  const large = await open(join(source, 'large.bin'), 'w');
  await large.truncate(MAX_FILE_BYTES + 1);
  await large.close();
  await assert.rejects(stageCloneSkillFiles(source, stage), /exceeds 4 MB/);
  assert.deepEqual(await readdir(stage), [], 'size checks precede clone file reads');
}

async function checkStreamBounds(): Promise<void> {
  const stage = join(root, 'stream-stage');
  const file = { path: 'SKILL.md', size: MAX_FILE_BYTES };
  await assert.rejects(stageSkillFile(Readable.from([Buffer.alloc(MAX_FILE_BYTES), Buffer.from('x')]),
    stage, file, { total: 0 }), /size limit/);
  await rm(stage, { recursive: true, force: true });
  await assert.rejects(stageSkillFile(Readable.from([Buffer.from('x')]), stage,
    { path: 'SKILL.md', size: 1 }, { total: MAX_TOTAL_BYTES }), /size limit/);
}

async function checkRealGitFallback(): Promise<void> {
  const git = promisify(execFile);
  const source = join(root, 'git-source');
  await mkdir(source);
  await writeFile(join(source, 'SKILL.md'), skill);
  await mkdir(join(source, 'references'));
  await writeFile(join(source, 'references', 'guide.md'), 'local git fixture');
  await git('git', ['init', source]);
  await git('git', ['-C', source, 'add', '.']);
  await git('git', ['-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'test: add skill fixture']);
  const env = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_ALLOW_PROTOCOL'];
  const previous = env.map((name) => process.env[name]);
  try {
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.file://${source}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/fixtures/skill';
    process.env.GIT_ALLOW_PROTOCOL = 'file';
    globalThis.fetch = async () => new Response('', { status: 403 });
    const result = await installGitHubSkill('fixtures/skill', 'fallback');
    assert.equal(result.source, 'git-clone');
    assert.equal(await readFile(join(installed, 'fallback', 'references', 'guide.md'), 'utf8'), 'local git fixture');
  } finally {
    env.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    mockApi();
  }
}

async function checkConcurrentPublication(): Promise<void> {
  const dir = join(installed, 'concurrent');
  const first = join(root, 'first-publication');
  const second = join(root, 'second-publication');
  await mkdir(dir);
  await writeFile(join(dir, 'custom.txt'), 'original');
  const firstFiles = ['SKILL.md', 'first.txt'];
  const secondFiles = ['SKILL.md', ...Array.from({ length: 50 }, (_, index) => `second-${index}.txt`)];
  for (const [stage, names, body] of [[first, firstFiles, 'first'], [second, secondFiles, 'second']] as const) {
    await mkdir(stage);
    for (const name of names) await writeFile(join(stage, name), body);
  }
  const files = (names: string[], size: number) => names.map((path) => ({ path, size }));
  await Promise.all([
    publishSkillFiles(first, dir, files(firstFiles, 5)),
    publishSkillFiles(second, dir, files(secondFiles, 6)),
  ]);
  assert.equal(await readFile(join(dir, 'custom.txt'), 'utf8'), 'original');
  assert.equal(await readFile(join(dir, 'first.txt'), 'utf8'), 'first', 'a later publication preserves the earlier completed install');
  assert.equal(await readFile(join(dir, 'second-49.txt'), 'utf8'), 'second');
  assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), 'second');
}

try {
  seedKeystore({ OPENCHATCUT_SKILLS_DIR: installed });
  mockApi();
  const result = await installGitHubSkill('fixtures/skill');
  assert.equal(result.source, 'api');
  assert.equal(result.slug, 'checked-skill');
  assert.deepEqual(result.files, paths);
  assert.deepEqual(await readFile(join(installed, result.slug, paths[1]!)), contents[1]);
  assert.equal((await readFile(join(installed, result.slug, paths[2]!))).length, 0);
  await rejectsTree([{ ...tree[0]!, mode: '120000' }], /symbolic links/);
  await rejectsTree([{ ...tree[0]!, path: '../SKILL.md' }], /invalid skill file path/);
  await rejectsTree([{ ...tree[0]!, size: MAX_FILE_BYTES + 1 }], /exceeds 4 MB/);
  await rejectsTree([{ ...tree[0]!, size: undefined as unknown as number }], /invalid file size/);
  await rejectsTree([...tree, ...Array.from({ length: 17 }, (_, index) => ({
    ...tree[1]!, path: `assets/${index}.bin`, size: MAX_FILE_BYTES,
  }))], /exceed 64 MB/);
  const dir = join(installed, result.slug);
  await writeFile(join(dir, 'custom.txt'), 'keep user-added support file');
  await writeFile(join(dir, 'SKILL.md'), 'old skill');
  failBlob = 1;
  await assert.rejects(installGitHubSkill('fixtures/skill'), /GitHub blob 500/);
  assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), 'old skill');
  failBlob = -1;
  await installGitHubSkill('fixtures/skill');
  assert.equal(await readFile(join(dir, 'custom.txt'), 'utf8'), 'keep user-added support file');
  await rm(join(dir, 'assets'), { recursive: true });
  const outside = join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, join(dir, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(installGitHubSkill('fixtures/skill'), /destination must be a directory/);
  assert.deepEqual(await readdir(outside), []);
  assert.equal(await readFile(join(dir, 'SKILL.md'), 'utf8'), skill);
  await checkCloneBoundaries();
  await checkStreamBounds();
  await checkRealGitFallback();
  await checkConcurrentPublication();
  console.log('skill-install.verify: ok (API, real git fallback, symlinks, preflight/stream limits, atomic overlay)');
} finally {
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}
