// Pull ALL ChatCut templates from chatcut-reverse/templates into the app:
//  - src/assets/chatcut-templates.json  (code + meta + full prop schema)
//  - public/thumbnails/<id>.jpg  (library thumbnails)
// Source of truth: per-template meta.json (identical to _catalog.json entries
// except previewAsset). Prop schema keeps the FULL source fields
// {key,type,defaultValue,label?,min?,max?,step?,options?}; template level
// carries description?/tags? when present.
import { readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const SRC = '/Users/qinpx/Desktop/project/chatcut-reverse/templates';
const OUT_JSON = new URL('../src/assets/chatcut-templates.json', import.meta.url);
const THUMB_DIR = new URL('../public/thumbnails/', import.meta.url).pathname;

rmSync(THUMB_DIR, { recursive: true, force: true });
mkdirSync(THUMB_DIR, { recursive: true });

const sanitize = (s) => s.replace(/[^a-zA-Z0-9_-]/g, '_');

// Source prop → full PropSpec. Some source props use {name,default} instead of
// {key,defaultValue}; normalize so every entry has key/type/defaultValue.
function toPropSpec(p) {
  const spec = {
    key: p.key ?? p.name,
    type: p.type,
    defaultValue: p.defaultValue ?? p.default ?? null,
  };
  if (p.label != null) spec.label = p.label;
  if (typeof p.min === 'number') spec.min = p.min;
  if (typeof p.max === 'number') spec.max = p.max;
  if (typeof p.step === 'number') spec.step = p.step;
  if (Array.isArray(p.options) && p.options.length) spec.options = p.options;
  return spec;
}

// Merge properties across ALL motionGraphicAssets. Dedup by (assetIndex,key):
// only true repeats within one asset are dropped; the same key appearing in a
// later asset is kept (e.g. AI video script builder asset[1] adds
// transparentBackground that asset[0] lacks — 19 source props stay 19).
function collectPropSpecs(assets) {
  const specs = [];
  const seen = new Set();
  assets.forEach((asset, assetIndex) => {
    for (const p of asset.properties || []) {
      const spec = toPropSpec(p);
      if (spec.key == null) continue;
      const dedupKey = `${assetIndex}:${spec.key}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      specs.push(spec);
    }
  });
  return specs;
}

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
  const assets = meta.motionGraphicAssets || [];
  const mga = assets[0] || {};
  const id = sanitize(String(meta.id || dir));
  const propSchema = collectPropSpecs(assets);
  const props = {};
  for (const s of propSchema) props[s.key] = s.defaultValue;

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
    ...(meta.description ? { description: meta.description } : {}),
    ...(Array.isArray(meta.tags) && meta.tags.length ? { tags: meta.tags } : {}),
    width: meta.compositionWidth || 1920,
    height: meta.compositionHeight || 1080,
    fps: meta.fps || 30,
    durationInFrames: mga.durationInFrames || meta.durationInFrames || 90,
    props,
    propSchema,
    thumb,
    code,
  });
}

// stable order: category then name
templates.sort((a, b) => (a.category === b.category ? a.name.localeCompare(b.name) : a.category.localeCompare(b.category)));
writeFileSync(OUT_JSON, JSON.stringify(templates, null, 2));

// ── run log: counts + field coverage ──
const byCat = {};
const fieldCov = { label: 0, min: 0, max: 0, step: 0, options: 0 };
let nProps = 0;
for (const t of templates) {
  byCat[t.category] = (byCat[t.category] || 0) + 1;
  for (const s of t.propSchema) {
    nProps++;
    for (const f of Object.keys(fieldCov)) if (f in s) fieldCov[f]++;
  }
}
console.log(`wrote ${templates.length} templates (skipped ${skipped}), thumbnails: ${templates.filter((t) => t.thumb).length}`);
console.log(`propSchema entries: ${nProps}, field coverage:`, JSON.stringify(fieldCov));
console.log(`with description: ${templates.filter((t) => t.description).length}, with tags: ${templates.filter((t) => t.tags).length}`);
console.log('by category:', JSON.stringify(byCat));
