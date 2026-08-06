import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { CustomSkill } from '../../persist/skillStore';
import type { SkillFile } from './plugin-skills';
import type { SkillDefinition } from './skill-types';

const expectedCreativeSlugs = [
  'long-video-to-shorts',
  'multi-clips-to-reels',
  'ai-cinematic-short-film',
  'product-ad-video-script',
  'explainer-video',
  'motion-graphic-placement',
  'storyboard-shot-breakdown',
  'video-thumbnail-generator',
  'skill-creator',
];
const root = fileURLToPath(new URL('../../../', import.meta.url));
const vite = await createServer({
  root,
  configFile: false,
  logLevel: 'silent',
  appType: 'custom',
  server: { middlewareMode: true },
});

try {
  const pluginFiles = await vite.ssrLoadModule('/src/agent/skills/plugin-skills.ts') as {
    PLUGIN_SKILLS: SkillFile[];
  };
  const catalog = await vite.ssrLoadModule('/src/agent/skills/skills-catalog.ts') as {
    CREATIVE_SKILLS: SkillDefinition[];
    setCustomSkills: (skills: SkillDefinition[]) => void;
  };
  const loader = await vite.ssrLoadModule('/src/agent/tools/plugin-skill-tools.ts') as {
    execPluginSkillTool: (name: string, args: Record<string, unknown>) => unknown;
  };
  const prompts = await vite.ssrLoadModule('/src/agent/systemPrompt.ts') as {
    creativeModePrompt: (skill: SkillDefinition | undefined) => string;
  };
  const store = await vite.ssrLoadModule('/src/persist/skillStore.ts') as {
    normalizeStoredCustomSkill: (value: unknown) => CustomSkill | undefined;
  };

  assert.equal(pluginFiles.PLUGIN_SKILLS.length, 25);
  assert.deepEqual(catalog.CREATIVE_SKILLS.map((skill) => skill.slug), expectedCreativeSlugs);
  for (const skill of pluginFiles.PLUGIN_SKILLS) {
    for (const match of skill.body.matchAll(/\]\((?:\.\/)?([^)\s#?]+\.md)(?:[?#][^)]*)?\)/g)) {
      const reference = match[1];
      assert(
        skill.files.includes(reference),
        `${skill.slug} references missing support file ${reference}`,
      );
    }
  }
  for (const skill of catalog.CREATIVE_SKILLS) {
    assert(skill.description.length > 0);
    assert(skill.body.trimStart().startsWith('# '));
    const loaded = loader.execPluginSkillTool('load_skill', { name: skill.slug });
    assert(loaded && typeof loaded === 'object' && 'contents' in loaded);
    const contents = (loaded as { contents: Record<string, string> }).contents;
    assert.equal(contents['SKILL.md'], skill.body);
    assert(Object.keys(contents).length >= 1, 'full load must include every support file');
    const prompt = prompts.creativeModePrompt(skill);
    assert.match(prompt, new RegExp(`name="${skill.slug}"`));
    assert(!prompt.includes(skill.body));
  }

  const withSupport = pluginFiles.PLUGIN_SKILLS.find((skill) => skill.files.length > 0);
  assert(withSupport, 'at least one bundled skill must expose a support file');
  const support = loader.execPluginSkillTool('load_skill', {
    name: withSupport.slug,
    file: withSupport.files[0],
  });
  assert(support && typeof support === 'object' && 'contents' in support);
  const supportContents = (support as { contents: Record<string, string> }).contents;
  assert(typeof supportContents[withSupport.files[0]], 'string');
  // full load: every support file of a bundled skill is returned up front
  for (const file of withSupport.files) {
    assert(supportContents[file] !== undefined, `full load missing ${file}`);
  }

  const custom: SkillDefinition = {
    id: 'skill_contract_check',
    slug: 'explainer-video',
    name: 'Prompt Contract Check',
    nameZh: '提示词契约检查',
    description: 'Verify progressive skill disclosure.',
    summary: 'Verify progressive skill disclosure.',
    scenarios: ['verification'],
    body: '# Workflow\n\nPRIVATE_SKILL_BODY_SENTINEL',
    files: [],
    source: 'custom',
  };
  catalog.setCustomSkills([custom]);
  const customPrompt = prompts.creativeModePrompt(custom);
  assert.match(customPrompt, /name="skill_contract_check"/);
  assert(!customPrompt.includes('PRIVATE_SKILL_BODY_SENTINEL'));
  const customLoaded = loader.execPluginSkillTool('load_skill', { name: custom.id });
  assert(customLoaded && typeof customLoaded === 'object' && 'contents' in customLoaded);
  assert.equal((customLoaded as { contents: Record<string, string> }).contents['SKILL.md'], custom.body);
  catalog.setCustomSkills([]);

  const migrated = store.normalizeStoredCustomSkill({
    id: 'skill_legacy',
    name: 'Legacy Skill',
    nameZh: '旧技能',
    summary: 'Legacy summary',
    scenarios: ['legacy'],
    body: '---\nname: legacy-skill\ndescription: Legacy route\n---\n\n# Workflow',
    builtin: false,
    createdAt: 1,
  });
  assert(migrated);
  assert.equal(migrated.slug, 'legacy-skill');
  assert.equal(migrated.description, 'Legacy route');
  assert.equal(migrated.source, 'custom');
} finally {
  await vite.close();
}

console.log('skill loading checks passed');
