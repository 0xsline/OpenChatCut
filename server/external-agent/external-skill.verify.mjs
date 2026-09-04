import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = resolve(root, 'skills/openchatcut');
const skillPath = resolve(skillRoot, 'SKILL.md');
const skill = readFileSync(skillPath, 'utf8').replace(/\r\n?/g, '\n');

assert.match(skill, /^---\nname: openchatcut\ndescription: .+\n---/);
assert.ok(skill.split('\n').length <= 500, 'SKILL.md must stay within 500 lines');

const references = [...skill.matchAll(/`(references\/[^`]+\.md)`/g)].map((match) => match[1]);
assert.ok(references.length > 0, 'SKILL.md must route to at least one reference');
for (const reference of references) {
  assert.ok(existsSync(resolve(skillRoot, reference)), `missing ${reference}`);
}

const skillVersion = /## Skill version\s+\n`([^`]+)`/.exec(skill)?.[1];
const mcp = readFileSync(resolve(root, 'server/external-agent/mcp.ts'), 'utf8');
const serverBaseline = /OPENCHATCUT_SKILL_BASELINE = '([^']+)'/.exec(mcp)?.[1];
assert.equal(skillVersion, serverBaseline, 'skill version must match the MCP baseline');
const knownErrors = readFileSync(resolve(skillRoot, 'references/known-errors.md'), 'utf8');
assert.match(knownErrors, /`list_edit_sessions`/);
assert.match(knownErrors, /`recover_edit_session`/);

console.log(`external skill verify: ok (${skillVersion}, ${references.length} references)`);
