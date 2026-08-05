// Runnable check: `npx tsx server/skills-files.verify.ts`.
// Pure-fs layer of the user-visible skill files under ~/.openchatcut/skills/.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverSkillFiles,
  displaySkillPath,
  mirrorSkillFile,
  removeSkillFile,
  skillDirFor,
} from './skills-files.ts';

const root = await mkdtemp(join(tmpdir(), 'occ-skills-'));

// slug whitelist + traversal defense
assert.equal(skillDirFor(root, 'my-skill'), join(root, 'my-skill'));
assert.equal(skillDirFor(root, 'bad/slug'), null);
assert.equal(skillDirFor(root, '../escape'), null);
assert.equal(skillDirFor(root, '.hidden'), null);
assert.equal(skillDirFor(root, ''), null);

// mirror writes SKILL.md idempotently
const body = '---\nname: my-skill\ndescription: Use when testing.\n---\n# My Skill\nWorkflow body.';
const path = await mirrorSkillFile(root, 'my-skill', body);
assert.equal(path, join(root, 'my-skill', 'SKILL.md'));
assert.equal(await readFile(path!, 'utf8'), body);
assert.equal(await mirrorSkillFile(root, 'my-skill', body), path, 'idempotent');

// discovery reads mirrored + user-dropped files, ignores junk
await writeFile(join(root, 'user-dropped', 'SKILL.md'), '---\nname: user-dropped\ndescription: Hand written.\n---\n# User\nBody.', { flag: 'wx' }).catch(async () => {
  await mkdir(join(root, 'user-dropped'), { recursive: true });
  await writeFile(join(root, 'user-dropped', 'SKILL.md'), '---\nname: user-dropped\ndescription: Hand written.\n---\n# User\nBody.');
});
await mkdir(join(root, 'not-a-skill'), { recursive: true });
await writeFile(join(root, 'not-a-skill', 'README.md'), 'no SKILL.md here');
const found = await discoverSkillFiles(root);
assert.deepStrictEqual(found.map((s) => s.slug), ['my-skill', 'user-dropped'], 'mirrored + user-dropped, junk ignored');
assert.ok(found[0]!.body.includes('# My Skill'), 'verbatim body');

// remove deletes the directory; missing slug is a no-op false
assert.equal(await removeSkillFile(root, 'my-skill'), true);
assert.equal(await removeSkillFile(root, 'my-skill'), false, 'second remove reports nothing existed');
assert.equal(await removeSkillFile(root, '../escape'), false, 'unsafe slug never touches fs');

// display path is portable and human-readable
assert.equal(displaySkillPath('demo'), join('~', '.openchatcut', 'skills', 'demo'));

await rm(root, { recursive: true, force: true });
console.log('skills-files.check: ok');
