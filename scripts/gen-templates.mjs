// Pulls real ChatCut templates from chatcut-reverse/templates into src/chatcut-templates.json
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC = '/Users/qinpx/Desktop/project/chatcut-reverse/templates';
const OUT = new URL('../src/chatcut-templates.json', import.meta.url);

// hand-pick a diverse, self-contained set (avoid chart-heavy ones for the seam proof)
const PICKS = [
  'popular-uncategorized/Dark-Tech-Callout-Tag',
  'popular-uncategorized/Quote-card-slide-in-with-word-by-word-reveal',
  'popular-uncategorized/Name-card-animation',
];

// also auto-scan title-cards + text-effects for a couple more non-empty ones
function scan(cat, limit) {
  const base = join(SRC, cat);
  if (!existsSync(base)) return [];
  const out = [];
  for (const d of readdirSync(base)) {
    const dir = join(base, d);
    const jsx = readdirSync(dir).find(f => f.endsWith('.jsx'));
    if (!jsx) continue;
    const code = readFileSync(join(dir, jsx), 'utf8');
    if (code.trim().length < 40) continue;          // skip empty
    if (!/const\s+\w+\s*=\s*\(\s*\{?\s*item/.test(code)) continue; // must be ({item})=>
    out.push(`${cat}/${d}`);
    if (out.length >= limit) break;
  }
  return out;
}

const rels = [...PICKS, ...scan('title-cards', 2), ...scan('text-effects', 2)];
const templates = [];
for (const rel of rels) {
  const dir = join(SRC, rel);
  if (!existsSync(dir)) { console.warn('skip missing', rel); continue; }
  const jsxFile = readdirSync(dir).find(f => f.endsWith('.jsx'));
  const metaFile = readdirSync(dir).find(f => f === 'meta.json');
  if (!jsxFile || !metaFile) { console.warn('skip incomplete', rel); continue; }
  const code = readFileSync(join(dir, jsxFile), 'utf8');
  if (code.trim().length < 40) { console.warn('skip empty', rel); continue; }
  const meta = JSON.parse(readFileSync(join(dir, metaFile), 'utf8'));
  const mga = (meta.motionGraphicAssets || [{}])[0] || {};
  const props = {};
  for (const p of (mga.properties || [])) props[p.key] = p.defaultValue;
  templates.push({
    id: meta.id || rel,
    name: meta.name || rel.split('/').pop(),
    category: meta.category || rel.split('/')[0],
    width: meta.compositionWidth || 1920,
    height: meta.compositionHeight || 1080,
    fps: meta.fps || 30,
    durationInFrames: mga.durationInFrames || meta.durationInFrames || 90,
    props,
    propSchema: (mga.properties || []).map(p => ({ key: p.key, type: p.type, defaultValue: p.defaultValue })),
    code,
  });
}
writeFileSync(OUT, JSON.stringify(templates, null, 2));
console.log(`wrote ${templates.length} templates:`);
for (const t of templates) console.log(`  - ${t.name} (${t.category}) ${t.width}x${t.height} ${t.durationInFrames}f, ${Object.keys(t.props).length} props`);
