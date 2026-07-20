// Pure YAML-frontmatter extractor for the plugin SKILL.md files
// Handles `name` (plain slug), `description` in all three shapes the
// files use — plain single line, double-quoted, and a `|` block scalar — and returns
// the verbatim body after the closing `---`. No Vite `?raw` import here on purpose, so
// this (and the check that exercises it) runs under tsx/node.

export interface SkillFront {
  name: string;
  description: string;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillFrontmatter(raw: string): SkillFront {
  const m = raw.match(FRONTMATTER);
  if (!m) return { name: '', description: '', body: raw };
  const [, front, body] = m;
  return { name: fieldName(front), description: fieldDescription(front), body };
}

function fieldName(front: string): string {
  const m = front.match(/^name:\s*(.*)$/m);
  return m ? unquote(m[1].trim()) : '';
}

function fieldDescription(front: string): string {
  const lines = front.split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return '';
  const first = lines[i].replace(/^description:\s*/, '');
  // YAML block scalar (`|`, `|-`, `>`, …) or an empty inline value → collect indented lines.
  if (first.trim() === '' || /^[|>][-+]?\s*$/.test(first.trim())) {
    const block: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const l = lines[j];
      if (l.trim() === '') { block.push(''); continue; }
      if (!/^\s/.test(l)) break; // dedented → next frontmatter key
      block.push(l.replace(/^\s+/, ''));
    }
    return block.join(' ').replace(/\s+/g, ' ').trim();
  }
  return unquote(first.trim());
}

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}
