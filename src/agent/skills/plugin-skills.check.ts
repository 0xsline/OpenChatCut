// Runnable check: `npx tsx src/agent/plugin-skills.check.ts`.
// Verifies the 15 agent-plugin skills are present + verbatim + parse cleanly. Reads the
// SKILL.md files from disk (not via plugin-skills.ts, which uses Vite `?raw` and can't
// load under tsx) and exercises the pure frontmatter parser on all three source shapes.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseSkillFrontmatter } from './skill-frontmatter';

const SKILLS_DIR = dirname(fileURLToPath(import.meta.url));  // check 与技能内容同目录
const EXPECTED = [
  'asset-import', 'openchatcut-plugin-basics', 'create-motion-graphics', 'export', 'image-gen',
  'known-errors', 'music', 'product-help', 'shader-gen', 'talking-head-guide',
  'transcription', 'verification', 'video-gen', 'voice', 'widget-forms',
];

// Every expected skill dir is present, and no extras.
const slugs = readdirSync(SKILLS_DIR).filter((d) => statSync(join(SKILLS_DIR, d)).isDirectory()).sort();
assert.deepStrictEqual(slugs, [...EXPECTED].sort(), '15 个源 agent-plugin 技能全部搬到,无多无少');

// Each SKILL.md parses to name(=slug) + non-empty description + substantive verbatim body.
for (const slug of slugs) {
  const raw = readFileSync(join(SKILLS_DIR, slug, 'SKILL.md'), 'utf8');
  const { name, description, body } = parseSkillFrontmatter(raw);
  assert.strictEqual(name, slug, `${slug}: frontmatter name 应等于 slug`);
  assert.ok(description.length > 20, `${slug}: description 解析非空`);
  assert.ok(body.trim().length > 100, `${slug}: SKILL.md 正文有实质内容`);
  // Verbatim: the parsed body is a suffix of the original bytes (nothing rewritten).
  assert.ok(raw.endsWith(body), `${slug}: 正文是原文件的逐字后缀（未改写）`);
}

// Parser handles all three source description shapes.
const plain = parseSkillFrontmatter('---\nname: a\ndescription: Use when X.\n---\nBODY');
assert.strictEqual(plain.description, 'Use when X.', '裸行 description');
const quoted = parseSkillFrontmatter('---\nname: b\ndescription: "Use for Y, Z."\n---\nBODY');
assert.strictEqual(quoted.description, 'Use for Y, Z.', '双引号 description 去引号');
const block = parseSkillFrontmatter('---\nname: c\ndescription: |\n  Line one\n  line two.\nuser-invocable: true\n---\nBODY');
assert.strictEqual(block.description, 'Line one line two.', '`|` 块 description 拼接并在下个 key 处停止');
assert.strictEqual(block.body, 'BODY', '块 description 不吞掉正文');

// A known skill loads a real support file (voice/references/voices.md exists on disk).
const voiceRef = readFileSync(join(SKILLS_DIR, 'voice', 'references', 'voices.md'), 'utf8');
assert.ok(voiceRef.length > 0, 'references 支撑文件也随技能搬来');

console.log(`plugin-skills.check: ok (${slugs.length} 技能 / frontmatter 三形态 / references 齐)`);
