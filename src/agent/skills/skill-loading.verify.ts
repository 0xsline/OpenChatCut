import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { CustomSkill } from '../../persist/skillStore';
import type { SkillFile } from './plugin-skills';
import type { SkillDefinition } from './skill-types';

const expectedCreativeSlugs = [
  'livestream-to-clips',
  'long-video-to-shorts',
  'multi-clips-to-reels',
  'ai-cinematic-short-film',
  'product-ad-video-script',
  'explainer-video',
  'motion-graphic-placement',
  'storyboard-shot-breakdown',
  'video-thumbnail-generator',
  'news-rough-cut',
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
    normalizeSkillArgs: (args: Record<string, unknown>) => Record<string, unknown>;
  };
  const prompts = await vite.ssrLoadModule('/src/agent/systemPrompt.ts') as {
    creativeModePrompt: (skill: SkillDefinition | undefined) => string;
  };
  const store = await vite.ssrLoadModule('/src/persist/skillStore.ts') as {
    normalizeStoredCustomSkill: (value: unknown) => CustomSkill | undefined;
  };

  assert.equal(pluginFiles.PLUGIN_SKILLS.length, 27);
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
    assert.deepEqual(Object.keys(contents), ['SKILL.md'], 'initial load returns only the root workflow');
    const prompt = prompts.creativeModePrompt(skill);
    assert.match(prompt, new RegExp(`name="${skill.slug}"`));
    assert(!prompt.includes(skill.body));
  }

  const withSupport = pluginFiles.PLUGIN_SKILLS.find((skill) => skill.files.length > 0);
  assert(withSupport, 'at least one bundled skill must expose a support file');
  const initial = loader.execPluginSkillTool('load_skill', { name: withSupport.slug });
  assert(initial && typeof initial === 'object' && 'contents' in initial && 'omittedFiles' in initial);
  const initialResult = initial as {
    contents: Record<string, string>;
    omittedFiles: string[];
  };
  assert.equal(initialResult.contents['SKILL.md'], withSupport.body);
  assert.deepEqual(
    initialResult.omittedFiles,
    [...withSupport.files].sort(),
    'initial load advertises every support file without injecting its contents',
  );
  const support = loader.execPluginSkillTool('load_skill', {
    name: withSupport.slug,
    file: withSupport.files[0],
    offset: 0,
  });
  assert(support && typeof support === 'object' && 'contents' in support);
  const supportContents = (support as { contents: Record<string, string> }).contents;
  assert.equal(typeof supportContents[withSupport.files[0]], 'string');

  // Normalization rules, independent of any skill's contents.
  const norm = loader.normalizeSkillArgs;
  assert.deepEqual(norm({ name: 's', file: '' }), { name: 's' }, 'a blank file is dropped');
  assert.deepEqual(norm({ name: 's', file: '   ' }), { name: 's' }, 'a whitespace file is dropped');
  assert.deepEqual(norm({ name: 's', file: null }), { name: 's' }, 'a null file is dropped');
  assert.deepEqual(norm({ name: 's', files: [] }), { name: 's' }, 'an empty files array is dropped');
  assert.deepEqual(norm({ name: 's', files: ['', ' '] }), { name: 's' }, 'an all-blank files array is dropped');
  assert.deepEqual(norm({ name: 's', files: ['', 'a.md'] }), { name: 's', files: ['a.md'] }, 'blank entries are stripped');
  assert.deepEqual(norm({ name: 's', files: ' a.md ' }), { name: 's', files: ['a.md'] }, 'a bare string is a trimmed one-file batch');
  assert.deepEqual(norm({ name: 's', file: ['a.md'] }), { name: 's', file: 'a.md' }, 'a one-element array on file is one file');
  assert.deepEqual(norm({ name: 's', file: ['a.md', 'b.md'] }), { name: 's', files: ['a.md', 'b.md'] }, 'a longer array on file is a batch');
  assert.deepEqual(norm({ name: 's', file: ' a.md ' }), { name: 's', file: 'a.md' }, 'file paths are trimmed');
  assert.deepEqual(norm({ name: 's', file: 'a.md', offset: '5', limit: '10' }), { name: 's', file: 'a.md', offset: 5, limit: 10 }, 'integer strings become integers');
  assert.deepEqual(norm({ name: 's', file: 'a.md', offset: null, limit: '' }), { name: 's', file: 'a.md' }, 'null and blank paging numbers are filler');
  assert.deepEqual(
    norm({ name: 's', file: 'a.md', files: ['b.md'], offset: 5, limit: 10 }),
    { name: 's', file: 'a.md', offset: 5, limit: 10 },
    'a non-zero offset is a continuation: file wins and files is dropped',
  );
  assert.deepEqual(
    norm({ name: 's', file: 'a.md', files: ['b.md'], offset: 0, limit: 10 }),
    { name: 's', files: ['b.md'] },
    'offset 0 is not a continuation: the batch wins',
  );
  assert.deepEqual(
    norm({ name: 's', file: 'a.md', files: ['b.md'] }),
    { name: 's', files: ['b.md'] },
    'without paging numbers the batch wins',
  );
  assert.deepEqual(
    norm({ name: 's', offset: 5, limit: 10 }),
    { name: 's' },
    'paging numbers never survive without a file',
  );
  assert.deepEqual(
    norm({ name: 's', files: ['a.md'], offset: 5 }),
    { name: 's', files: ['a.md'] },
    'paging numbers never survive beside a batch',
  );
  assert.deepEqual(
    norm({ name: 's', file: 42 }),
    { name: 's', file: 42 },
    'wrong-typed selectors survive so validation still reports them',
  );

  // Models routinely emit both selectors in one call. Every shape below was rejected before
  // normalization existed, which stalled the skill behind an unrecoverable argument error.
  type LoadResult = {
    contents?: Record<string, string>;
    files?: string[];
    omittedFiles?: string[];
    offset?: number;
    nextOffset?: number | null;
    error?: string;
    retry?: string;
  };
  const load = (args: Record<string, unknown>): LoadResult => (
    loader.execPluginSkillTool('load_skill', args) as LoadResult
  );
  const firstSupport = withSupport.files[0];

  const normalizedCases: {
    readonly label: string;
    readonly args: Record<string, unknown>;
    readonly expect: (result: LoadResult) => void;
  }[] = [
    {
      label: 'blank file beside a real files array keeps the batch',
      args: { file: '', files: [firstSupport], offset: 0, limit: 48_000 },
      expect: (r) => assert.deepEqual(r.files, [firstSupport]),
    },
    {
      label: 'null file beside a real files array keeps the batch',
      args: { file: null, files: [firstSupport] },
      expect: (r) => assert.deepEqual(r.files, [firstSupport]),
    },
    {
      label: 'offset 0 beside both selectors keeps the batch (SKILL.md at 0 repeats the initial load)',
      args: { file: 'SKILL.md', files: [firstSupport], offset: 0, limit: 48_000 },
      expect: (r) => assert.deepEqual(r.files, [firstSupport]),
    },
    {
      label: 'a non-zero offset beside both selectors keeps the paged file',
      args: { file: 'SKILL.md', files: [firstSupport], offset: 2, limit: 48_000 },
      expect: (r) => { assert.deepEqual(r.files, ['SKILL.md']); assert.equal(r.offset, 2); },
    },
    {
      label: 'without paging numbers the batch wins over file',
      args: { file: 'SKILL.md', files: [firstSupport] },
      expect: (r) => assert.deepEqual(r.files, [firstSupport]),
    },
    {
      label: 'a bare string on files is a one-file batch',
      args: { files: firstSupport },
      expect: (r) => assert.deepEqual(r.files, [firstSupport]),
    },
    {
      label: 'string paging numbers are accepted',
      args: { file: 'SKILL.md', offset: '0', limit: '4000' },
      expect: (r) => assert.deepEqual(r.files, ['SKILL.md']),
    },
    {
      label: 'empty files array falls back to the initial load',
      args: { files: [] },
      expect: (r) => assert.deepEqual(r.files, ['SKILL.md']),
    },
    {
      label: 'files holding only blank strings falls back to the initial load',
      args: { files: ['', '   '] },
      expect: (r) => assert.deepEqual(r.files, ['SKILL.md']),
    },
    {
      label: 'blank entries are stripped while real paths survive',
      args: { files: ['', firstSupport] },
      expect: (r) => assert.deepEqual(r.files, [firstSupport]),
    },
    {
      label: 'blank file alone falls back to the initial load',
      args: { file: '' },
      expect: (r) => assert.deepEqual(r.files, ['SKILL.md']),
    },
    {
      label: 'paging numbers without a file are dropped, not rejected',
      args: { offset: 0, limit: 48_000 },
      expect: (r) => assert.deepEqual(r.files, ['SKILL.md']),
    },
    {
      label: 'paging numbers beside a files array are dropped, not rejected',
      args: { files: [firstSupport], offset: 0 },
      expect: (r) => assert.deepEqual(r.files, [firstSupport]),
    },
    {
      label: 'empty files array beside a real file keeps the paged file',
      args: { file: 'SKILL.md', files: [] },
      expect: (r) => assert.deepEqual(r.files, ['SKILL.md']),
    },
  ];
  for (const { label, args, expect } of normalizedCases) {
    const result = load({ name: withSupport.slug, ...args });
    assert.equal(result.error, undefined, `built-in: ${label} — ${result.error ?? ''}`);
    expect(result);
  }

  // Legal calls keep their existing meaning.
  assert.deepEqual(load({ name: withSupport.slug }).files, ['SKILL.md']);
  assert.deepEqual(load({ name: withSupport.slug, files: [firstSupport] }).files, [firstSupport]);
  const legalPage = load({ name: withSupport.slug, file: 'SKILL.md', offset: 0, limit: 4_000 });
  assert.deepEqual(legalPage.files, ['SKILL.md']);
  assert.equal(typeof legalPage.contents?.['SKILL.md'], 'string');

  // Genuinely invalid arguments still fail, and every rejection names a corrected call so the
  // same arguments are never the obvious thing to re-send.
  const rejected = [
    { name: withSupport.slug, file: '../secret.md' },
    { name: withSupport.slug, files: ['../secret.md'] },
    { name: withSupport.slug, files: [firstSupport, firstSupport] },
    { name: withSupport.slug, file: 'references/does-not-exist.md' },
    { name: withSupport.slug, file: 'SKILL.md', offset: -1 },
    { name: withSupport.slug, file: 'SKILL.md', limit: 999_999 },
    { name: withSupport.slug, files: 'references/not-an-array.md' },
  ];
  for (const args of rejected) {
    const result = load(args);
    assert(result.error, `expected a rejection for ${JSON.stringify(args)}`);
    assert(
      result.retry?.includes(`load_skill(name="${withSupport.slug}")`),
      `rejection must name a corrected call: ${JSON.stringify(args)}`,
    );
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

  // Custom skills run the same normalization; the original report reached one through a
  // custom slug, and the same shapes reached the bundled skills too.
  const customWithFiles: SkillDefinition = {
    id: 'skill_normalization_check',
    slug: 'skill-normalization-check',
    name: 'Normalization Check',
    nameZh: '参数归一化检查',
    description: 'Verify load_skill argument normalization for custom skills.',
    summary: 'Verify load_skill argument normalization for custom skills.',
    scenarios: ['verification'],
    body: '# Workflow\n\nSee [reference](references/breakdown.md).',
    files: ['references/breakdown.md'],
    fileContents: { 'references/breakdown.md': '# Breakdown\n\nCUSTOM_SUPPORT_SENTINEL' },
    source: 'custom',
  };
  catalog.setCustomSkills([customWithFiles]);
  const customSupport = 'references/breakdown.md';
  for (const { label, args, expect } of [
    {
      label: 'blank file beside a real files array keeps the batch',
      args: { file: '', files: [customSupport], offset: 0, limit: 48_000 },
      expect: (r: LoadResult) => assert.deepEqual(r.files, [customSupport]),
    },
    {
      label: 'offset 0 beside both selectors keeps the batch',
      args: { file: 'SKILL.md', files: [customSupport], offset: 0, limit: 48_000 },
      expect: (r: LoadResult) => assert.deepEqual(r.files, [customSupport]),
    },
    {
      label: 'a non-zero offset beside both selectors keeps the paged file',
      args: { file: 'SKILL.md', files: [customSupport], offset: 2 },
      expect: (r: LoadResult) => assert.deepEqual(r.files, ['SKILL.md']),
    },
    {
      label: 'empty files array falls back to the initial load',
      args: { files: [] },
      expect: (r: LoadResult) => assert.deepEqual(r.files, ['SKILL.md']),
    },
    {
      label: 'paging numbers without a file are dropped, not rejected',
      args: { offset: 0, limit: 48_000 },
      expect: (r: LoadResult) => assert.deepEqual(r.files, ['SKILL.md']),
    },
  ]) {
    const result = load({ name: customWithFiles.id, ...args });
    assert.equal(result.error, undefined, `custom: ${label} — ${result.error ?? ''}`);
    expect(result);
  }
  assert.equal(
    load({ name: customWithFiles.id, files: [customSupport] }).contents?.[customSupport],
    customWithFiles.fileContents?.[customSupport],
    'a normalized custom batch returns the real support-file content',
  );
  const customRejection = load({ name: customWithFiles.id, file: '../secret.md' });
  assert(customRejection.error);
  assert(
    customRejection.retry?.includes(`load_skill(name="${customWithFiles.id}")`),
    'custom rejections must name a corrected call',
  );
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
