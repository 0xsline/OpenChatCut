// Pull ALL ChatCut templates from chatcut-reverse/templates into the app:
//  - src/chatcut-templates.json  (code + meta + prop schema)
//  - public/thumbnails/<id>.jpg  (library thumbnails)
import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SRC = '/Users/qinpx/Desktop/project/chatcut-reverse/templates';
const OUT_JSON = new URL('../src/chatcut-templates.json', import.meta.url);
const THUMB_DIR = new URL('../public/thumbnails/', import.meta.url).pathname;

rmSync(THUMB_DIR, { recursive: true, force: true });
mkdirSync(THUMB_DIR, { recursive: true });

const sanitize = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

// every category/<template> dir
const dirs = [];
for (const cat of readdirSync(SRC)) {
  const catPath = join(SRC, cat);
  let entries;
  try { entries = readdirSync(catPath); } catch { continue; }
  for (const name of entries) dirs.push(join(catPath, name));
}

const templates = [];
let skipped = 0;
for (const dir of dirs) {
  let files;
  try { files = readdirSync(dir); } catch { continue; }
  const jsxFile = files.find((f) => f.endsWith('.jsx'));
  const metaFile = files.find((f) => f === 'meta.json');
  const thumbFile = files.find((f) => /\.(jpg|jpeg|png)$/i.test(f));
  if (!jsxFile || !metaFile) { skipped++; continue; }

  const code = readFileSync(join(dir, jsxFile), 'utf8');
  // must be a `const NAME = ({item...}) => ...` template
  if (code.trim().length < 40 || !/const\s+\w+\s*=\s*\(\s*\{?\s*item/.test(code)) { skipped++; continue; }

  const meta = JSON.parse(readFileSync(join(dir, metaFile), 'utf8'));
  const mga = (meta.motionGraphicAssets || [{}])[0] || {};
  const id = sanitize(String(meta.id || dir));
  const props = {};
  for (const p of mga.properties || []) props[p.key] = p.defaultValue;

  let thumb = null;
  if (thumbFile) {
    const ext = thumbFile.split('.').pop();
    copyFileSync(join(dir, thumbFile), join(THUMB_DIR, `${id}.${ext}`));
    thumb = `/thumbnails/${id}.${ext}`;
  }

  templates.push({
    id,
    name: meta.name || jsxFile.replace('.jsx', ''),
    category: meta.category || 'uncategorized',
    width: meta.compositionWidth || 1920,
    height: meta.compositionHeight || 1080,
    fps: meta.fps || 30,
    durationInFrames: mga.durationInFrames || meta.durationInFrames || 90,
    props,
    propSchema: (mga.properties || []).map((p) => ({ key: p.key, type: p.type, defaultValue: p.defaultValue })),
    thumb,
    code,
  });
}

// stable order: category then name
templates.sort((a, b) => (a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category)));
writeFileSync(OUT_JSON, JSON.stringify(templates, null, 2));

const byCat = {};
for (const t of templates) byCat[t.category] = (byCat[t.category] || 0) + 1;
console.log(`wrote ${templates.length} templates (skipped ${skipped}), thumbnails: ${templates.filter((t) => t.thumb).length}`);
console.log('by category:', JSON.stringify(byCat));
