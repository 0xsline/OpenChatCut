import './harness-context-checkpoint.verify-helper';
import assert from 'node:assert/strict';
import type { ModelMessage } from 'ai';
import {
  buildPluginSkillsIndex,
  buildSkillsIndex,
  PLUGIN_SKILLS,
} from './skills/plugin-skills';
import { buildBoundedSkillResult, buildPagedSkillResult } from './tools/plugin-skill-tools';
import { harnessContextForModelRound } from './harness-context';

const message = (role: 'user' | 'assistant', content: string): ModelMessage => ({ role, content });

const syntheticSkills = [
  { slug: 'z-last', description: 'Z'.repeat(220) },
  { slug: 'a-first', description: 'A'.repeat(220) },
  { slug: 'm-middle', description: 'M'.repeat(220) },
];
const full = buildSkillsIndex(syntheticSkills, { budgetChars: 4_000 });
const bounded = buildSkillsIndex(syntheticSkills, {
  budgetChars: full.prompt.length - 100,
});
const boundedAgain = buildSkillsIndex([...syntheticSkills].reverse(), {
  budgetChars: full.prompt.length - 100,
});
assert.deepEqual(boundedAgain, bounded, 'skill ordering and omission are cache-stable');
assert.ok(bounded.diagnostics.promptChars <= bounded.diagnostics.budgetChars);
assert.equal(bounded.diagnostics.totalSkills, syntheticSkills.length);
assert.equal(
  bounded.diagnostics.advertisedSkills + bounded.diagnostics.omittedSkills,
  bounded.diagnostics.totalSkills,
);
assert.equal(
  bounded.diagnostics.advertisedChars + bounded.diagnostics.omittedChars,
  bounded.diagnostics.totalChars,
);
assert.ok(bounded.diagnostics.omittedSkills > 0, 'focused budget forces exact omissions');
const sortedSlugs = syntheticSkills.map((skill) => skill.slug).sort();
const advertisedSlugs = sortedSlugs.slice(0, bounded.diagnostics.advertisedSkills);
for (const slug of advertisedSlugs) {
  assert.match(bounded.prompt, new RegExp(`\\n- \\*\\*${slug}\\*\\*`),
    `advertised skill ${slug} keeps its full catalog entry`);
}
const omittedSlugs = sortedSlugs.slice(bounded.diagnostics.advertisedSkills);
for (const slug of omittedSlugs) {
  assert.match(bounded.prompt, new RegExp(`\\n- ${slug}(?:\\n|$)`),
    `omitted description keeps exact slug ${slug} discoverable`);
}
const unavailable = buildSkillsIndex(syntheticSkills, {
  toolsAvailable: false,
  budgetChars: 1_000,
});
assert.match(unavailable.prompt, /cannot call tools/);
for (const skill of syntheticSkills) assert.doesNotMatch(unavailable.prompt, new RegExp(skill.slug));
assert.throws(
  () => buildSkillsIndex(syntheticSkills, { budgetChars: 10 }),
  /cannot fit/,
  'the prompt never silently exceeds a budget too small for exact slug discovery',
);
assert.equal(unavailable.diagnostics.advertisedSkills, 0);
assert.equal(unavailable.diagnostics.omittedSkills, syntheticSkills.length);

const bundled = buildPluginSkillsIndex();
assert.ok(bundled.diagnostics.promptChars <= bundled.diagnostics.budgetChars,
  'the static bundled skill index stays within its hard budget');
assert.equal(bundled.diagnostics.totalSkills, PLUGIN_SKILLS.length);
assert.equal(
  bundled.diagnostics.advertisedSkills + bundled.diagnostics.omittedSkills,
  PLUGIN_SKILLS.length,
);
const skillSource = {
  skill: 'budget-fixture',
  contents: {
    'references/b.md': 'B'.repeat(30_000),
    'SKILL.md': '# Exact primary workflow\\n' + 'S'.repeat(500),
    'references/a.md': 'A'.repeat(40_000),
  },
};
const firstSkillLoad = buildBoundedSkillResult(skillSource);
if ('error' in firstSkillLoad) assert.fail(firstSkillLoad.error);
assert.ok(JSON.stringify(firstSkillLoad).length <= 64_000);
assert.equal(firstSkillLoad.files[0], 'SKILL.md', 'initial load always prioritizes full SKILL.md');
assert.equal(firstSkillLoad.contents['SKILL.md'], skillSource.contents['SKILL.md']);
assert.deepEqual(firstSkillLoad.files, ['SKILL.md']);
assert.deepEqual(
  firstSkillLoad.omittedFiles,
  ['references/a.md', 'references/b.md'],
  'initial load returns only the root workflow and a complete support-file manifest',
);
const repeatedSkillLoad = buildBoundedSkillResult({
  ...skillSource,
  contents: {
    'references/a.md': skillSource.contents['references/a.md'],
    'references/b.md': skillSource.contents['references/b.md'],
    'SKILL.md': skillSource.contents['SKILL.md'],
  },
});
assert.deepEqual(repeatedSkillLoad, firstSkillLoad, 'support-file budgeting is deterministic');
const followupSkillLoad = buildBoundedSkillResult(skillSource, ['references/b.md']);
if ('error' in followupSkillLoad) assert.fail(followupSkillLoad.error);
assert.ok(JSON.stringify(followupSkillLoad).length <= 64_000);
assert.deepEqual(followupSkillLoad.files, ['references/b.md']);
assert.equal(followupSkillLoad.contents['references/b.md'], skillSource.contents['references/b.md']);
assert.deepEqual(followupSkillLoad.omittedFiles, []);
assert.deepEqual(
  buildBoundedSkillResult(skillSource, ['../secret.md']),
  { error: 'Unsafe skill file path: ../secret.md' },
  'follow-up paths cannot traverse outside the selected skill',
);
assert.deepEqual(
  buildBoundedSkillResult(skillSource, ['references/missing.md']),
  {
    error: 'Unknown skill file: references/missing.md',
    availableFiles: ['SKILL.md', 'references/a.md', 'references/b.md'],
  },
);
const pagedText = '🙂'.repeat(40_000);
const pagedSource = {
  skill: 'paging-fixture',
  contents: { 'SKILL.md': '# Paging', 'references/huge.md': pagedText },
};
const pagedInitial = buildBoundedSkillResult(pagedSource);
if ('error' in pagedInitial) assert.fail(pagedInitial.error);
assert.deepEqual(pagedInitial.omittedFiles, ['references/huge.md']);
const firstPage = buildPagedSkillResult(pagedSource, 'references/huge.md', 0, 48_000);
if ('error' in firstPage) assert.fail(firstPage.error);
assert.ok(JSON.stringify(firstPage).length <= 64_000);
assert.equal(firstPage.offset, 0);
assert.equal(firstPage.totalChars, pagedText.length);
const firstNextOffset = firstPage.nextOffset;
if (firstNextOffset === null || firstNextOffset === undefined) {
  assert.fail('oversized skill file must expose a nextOffset');
}
assert.equal(firstNextOffset % 2, 0, 'page boundary preserves emoji surrogate pairs');
const secondPage = buildPagedSkillResult(
  pagedSource,
  'references/huge.md',
  firstNextOffset,
  48_000,
);
if ('error' in secondPage) assert.fail(secondPage.error);
assert.equal(secondPage.nextOffset, null);
assert.equal(
  firstPage.contents['references/huge.md'] + secondPage.contents['references/huge.md'],
  pagedText,
  'paged follow-up reconstructs one oversized support file exactly',
);
assert.deepEqual(
  buildPagedSkillResult(pagedSource, 'references/huge.md', 1, 1),
  { error: 'offset must not split a UTF-16 surrogate pair.' },
);
assert.deepEqual(
  buildPagedSkillResult(pagedSource, 'references/huge.md', 0, 1),
  { error: 'limit must not split the first UTF-16 surrogate pair in a page.' },
);
const cjkRoot = '中文工作流🙂'.repeat(18_000);
const cjkSkill = {
  skill: 'large-cjk',
  contents: { 'SKILL.md': cjkRoot },
};
const roundHarness = harnessContextForModelRound({
  messages: [message('user', '请加载完整工作流。')],
  system: 'S'.repeat(4_000),
  toolSchemas: [{
    name: 'load_skill',
    description: 'Load a skill.',
    input_schema: { type: 'object', properties: {} },
  }],
  contextWindowTokens: 64_000,
  maxInputTokens: 60_000,
  maxOutputTokens: 4_096,
});
const computedCjkBudget = roundHarness.loadSkillResultBudgetChars;
if (
  typeof computedCjkBudget !== 'number'
  || computedCjkBudget <= 0
  || computedCjkBudget >= cjkRoot.length
) {
  assert.fail('a 64k model assigns a positive numeric skill-result budget below the oversized CJK root');
}
const cjkBudget: number = computedCjkBudget;
const cjkInitial = buildBoundedSkillResult(cjkSkill, undefined, cjkBudget);
if ('error' in cjkInitial) assert.fail(cjkInitial.error);
assert.equal(cjkInitial.file, 'SKILL.md');
assert.equal(cjkInitial.offset, 0);
assert.equal(cjkInitial.totalChars, cjkRoot.length);
assert.ok(cjkInitial.nextOffset, 'a 64k model pages a large CJK root instead of aborting');
let recoveredRoot = cjkInitial.contents['SKILL.md'];
let cjkOffset: number | null | undefined = cjkInitial.nextOffset;
while (cjkOffset !== null && cjkOffset !== undefined) {
  const page = buildPagedSkillResult(cjkSkill, 'SKILL.md', cjkOffset, 48_000, cjkBudget);
  if ('error' in page) assert.fail(page.error);
  assert.equal(page.offset, cjkOffset);
  recoveredRoot += page.contents['SKILL.md'];
  cjkOffset = page.nextOffset;
}
assert.equal(recoveredRoot, cjkRoot, 'all UTF-16-safe root pages reconstruct the exact CJK skill');

console.log('harness-context.verify: checkpoint lineage, skill budget, and tool gating OK');
