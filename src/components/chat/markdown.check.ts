// Smoke: parseBlocks-ish behavior via Markdown module export surface.
// Inline unit without React: re-test regex patterns used by the renderer.
import assert from 'node:assert';

// mirror key parse rules from Markdown.tsx (keep in sync when changing parser)
function parseBlocks(src: string): { type: string; text?: string; items?: string[] }[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: { type: string; text?: string; items?: string[] }[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```([\w-]*)\s*$/);
    if (fence) {
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) { body.push(lines[i]); i += 1; }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { blocks.push({ type: 'h', text: h[2] }); i += 1; continue; }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const um = lines[i].match(/^[-*]\s+(.+)$/);
        if (!um) break;
        items.push(um[1]); i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (!line.trim()) { i += 1; continue; }
    const para: string[] = [line]; i += 1;
    while (i < lines.length && lines[i].trim() && !/^[-*]\s+/.test(lines[i]) && !/^```/.test(lines[i]) && !/^#/.test(lines[i])) {
      para.push(lines[i]); i += 1;
    }
    blocks.push({ type: 'p', text: para.join('\n') });
  }
  return blocks;
}

const sample = `找到 1 个：

- **id**: \`builtin:fx-bloom\`
- **name**: 光晕 Bloom

已确认 \`builtin:fx-bloom\`（**光晕 Bloom**）。`;

const blocks = parseBlocks(sample);
assert.ok(blocks.some((b) => b.type === 'ul' && b.items?.length === 2), 'ul with 2 items');
assert.ok(blocks.some((b) => b.type === 'p' && b.text?.includes('builtin:fx-bloom')), 'paragraph kept');
assert.ok(/\*\*[^*]+\*\*/.test(sample), 'sample has bold markers');

console.log('markdown.check: OK');
