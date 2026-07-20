// Runnable check: `npx tsx src/agent/skills-catalog.check.ts`.
// Verifies the ported creative-skill catalog + the prompt-injection helper.
import assert from 'node:assert';
import { CREATIVE_SKILLS, findSkill } from './skills-catalog';
import { creativeModePrompt } from '../systemPrompt';

// the 8 real catalog skills are present and well-formed
assert.strictEqual(CREATIVE_SKILLS.length, 8, 'expected 8 creative skills');
for (const s of CREATIVE_SKILLS) {
  assert.ok(s.id && s.name && s.nameZh && s.body, `skill ${s.name} is well-formed`);
  assert.ok(Array.isArray(s.scenarios), 'scenarios is an array');
  assert.ok(s.body.length > 500, `skill ${s.nameZh} has substantive instructions`);
}

// a known real skill is present with its zh name
const shorts = CREATIVE_SKILLS.find((s) => s.name === 'Long Video to Shorts');
assert.ok(shorts, 'Long Video to Shorts present');
assert.strictEqual(shorts!.nameZh, '长视频转短视频');

// findSkill: id lookup, null/undefined/unknown → undefined
assert.strictEqual(findSkill(shorts!.id)?.id, shorts!.id);
assert.strictEqual(findSkill(null), undefined);
assert.strictEqual(findSkill(undefined), undefined);
assert.strictEqual(findSkill('nope'), undefined);

// creativeModePrompt: empty for no skill, wraps the skill body otherwise
assert.strictEqual(creativeModePrompt(undefined), '');
const prompt = creativeModePrompt(shorts!);
assert.ok(prompt.includes('创作模式') && prompt.includes(shorts!.nameZh) && prompt.includes(shorts!.body), 'prompt embeds the skill body');

console.log('skills-catalog.check: ok');
