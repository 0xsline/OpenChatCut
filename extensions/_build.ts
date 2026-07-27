// Builder untuk plugin pack "VOX Explainer Motion".
// Baca 5 source JSX → compile-probe tiap code lewat sandbox compileTemplate
// (sama kayak probeTemplates di src/plugins/install.ts) → tulis pack JSON.
// Jalankan:  npx tsx extensions/_build.ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'vox-src');
const OUT = join(here, 'vox-explainer-motion.json');
const read = (name: string) => readFileSync(join(SRC, name), 'utf8');
const svgDataUrl = (svg: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.trim());

const COLORS = {
  paper: '#F2EEE3',
  ink: '#15140F',
  inkSoft: '#4A463B',
  accent: '#FFE100',
  alert: '#E2231A',
};

const specs = [
  {
    id: 'kinetic-headline', name: 'Kinetic Headline', file: 'kinetic-headline.jsx',
    width: 1920, height: 1080,
    desc: 'VOX kinetic headline: word-by-word pop, keyword highlighted with accent block sweep.',
    props: { headline: 'Why prices keep rising', kicker: 'THE ECONOMY · EPISODE 14', highlightIndex: 1, accentColor: COLORS.accent, inkColor: COLORS.ink, paperColor: COLORS.paper, font: 'Inter', transparentBackground: false },
    propSchema: [
      { key: 'headline', type: 'text', label: 'Headline' },
      { key: 'kicker', type: 'text', label: 'Kicker' },
      { key: 'highlightIndex', type: 'number', label: 'Highlight word index', defaultValue: 1, min: 0, max: 20, step: 1 },
      { key: 'accentColor', type: 'color', label: 'Accent', defaultValue: COLORS.accent },
      { key: 'inkColor', type: 'color', label: 'Ink', defaultValue: COLORS.ink },
      { key: 'paperColor', type: 'color', label: 'Paper', defaultValue: COLORS.paper },
      { key: 'font', type: 'font', label: 'Font', defaultValue: 'Inter' },
      { key: 'transparentBackground', type: 'boolean', label: 'Transparent BG', defaultValue: false },
    ],
  },
  {
    id: 'big-stat', name: 'Big Stat Count-up', file: 'big-stat.jsx',
    width: 1920, height: 1080,
    desc: 'VOX big stat: animated count-up, accent underline sweep, source line.',
    props: { value: 47, suffix: '%', label: 'of households affected', source: 'Source: Bureau of Statistics, 2025', accentColor: COLORS.accent, alertColor: COLORS.alert, inkColor: COLORS.ink, paperColor: COLORS.paper, font: 'Inter', transparentBackground: false },
    propSchema: [
      { key: 'value', type: 'number', label: 'Value', defaultValue: 47, min: 0, step: 1 },
      { key: 'suffix', type: 'text', label: 'Suffix', defaultValue: '%' },
      { key: 'label', type: 'text', label: 'Label' },
      { key: 'source', type: 'text', label: 'Source' },
      { key: 'accentColor', type: 'color', label: 'Underline', defaultValue: COLORS.accent },
      { key: 'alertColor', type: 'color', label: 'Suffix color', defaultValue: COLORS.alert },
      { key: 'inkColor', type: 'color', label: 'Ink', defaultValue: COLORS.ink },
      { key: 'paperColor', type: 'color', label: 'Paper', defaultValue: COLORS.paper },
      { key: 'font', type: 'font', label: 'Font', defaultValue: 'Inter' },
      { key: 'transparentBackground', type: 'boolean', label: 'Transparent BG', defaultValue: false },
    ],
  },
  {
    id: 'data-bars', name: 'Data Bar Grow', file: 'data-bars.jsx',
    width: 1920, height: 1080,
    desc: 'VOX data chart: bars grow with staggered ease, one bar in alert color.',
    props: { title: 'Where the money goes', dataJson: '[{"name":"Housing","val":34,"pct":100,"acc":true},{"name":"Food","val":22,"pct":65},{"name":"Transport","val":18,"pct":53},{"name":"Healthcare","val":14,"pct":41}]', barColor: COLORS.ink, alertColor: COLORS.alert, inkColor: COLORS.ink, paperColor: COLORS.paper, font: 'Inter', transparentBackground: false },
    propSchema: [
      { key: 'title', type: 'text', label: 'Title' },
      { key: 'dataJson', type: 'text', label: 'Data (JSON array)' },
      { key: 'barColor', type: 'color', label: 'Bar', defaultValue: COLORS.ink },
      { key: 'alertColor', type: 'color', label: 'Alert bar', defaultValue: COLORS.alert },
      { key: 'inkColor', type: 'color', label: 'Ink', defaultValue: COLORS.ink },
      { key: 'paperColor', type: 'color', label: 'Paper', defaultValue: COLORS.paper },
      { key: 'font', type: 'font', label: 'Font', defaultValue: 'Inter' },
      { key: 'transparentBackground', type: 'boolean', label: 'Transparent BG', defaultValue: false },
    ],
  },
  {
    id: 'lower-third', name: 'Lower-Third Reveal', file: 'lower-third.jsx',
    width: 1920, height: 1080,
    desc: 'VOX lower-third: accent bar grow + name/role mask wipe. Default transparent overlay.',
    props: { name: 'Maya Hartono', role: 'SENIOR ECONOMICS REPORTER', accentColor: COLORS.accent, inkColor: COLORS.ink, inkSoftColor: COLORS.inkSoft, paperColor: COLORS.paper, font: 'Inter', transparentBackground: true },
    propSchema: [
      { key: 'name', type: 'text', label: 'Name' },
      { key: 'role', type: 'text', label: 'Role' },
      { key: 'accentColor', type: 'color', label: 'Accent', defaultValue: COLORS.accent },
      { key: 'inkColor', type: 'color', label: 'Ink', defaultValue: COLORS.ink },
      { key: 'inkSoftColor', type: 'color', label: 'Ink soft', defaultValue: COLORS.inkSoft },
      { key: 'paperColor', type: 'color', label: 'Paper', defaultValue: COLORS.paper },
      { key: 'font', type: 'font', label: 'Font', defaultValue: 'Inter' },
      { key: 'transparentBackground', type: 'boolean', label: 'Transparent BG', defaultValue: true },
    ],
  },
  {
    id: 'pull-quote', name: 'Pull Quote Highlight', file: 'pull-quote.jsx',
    width: 1920, height: 1080,
    desc: 'VOX pull quote: word stagger, keyword highlighted with accent sweep, citation.',
    props: { quote: 'We have never seen a squeeze like this before.', highlightIndex: 5, citation: 'DR. ANWAR TAN · ECONOMIST, UI', accentColor: COLORS.accent, inkColor: COLORS.ink, paperColor: COLORS.paper, font: 'Inter', transparentBackground: false },
    propSchema: [
      { key: 'quote', type: 'text', label: 'Quote' },
      { key: 'highlightIndex', type: 'number', label: 'Highlight word index', defaultValue: 5, min: 0, max: 20, step: 1 },
      { key: 'citation', type: 'text', label: 'Citation' },
      { key: 'accentColor', type: 'color', label: 'Accent', defaultValue: COLORS.accent },
      { key: 'inkColor', type: 'color', label: 'Ink', defaultValue: COLORS.ink },
      { key: 'paperColor', type: 'color', label: 'Paper', defaultValue: COLORS.paper },
      { key: 'font', type: 'font', label: 'Font', defaultValue: 'Inter' },
      { key: 'transparentBackground', type: 'boolean', label: 'Transparent BG', defaultValue: false },
    ],
  },
];

const items = specs.map((s) => ({ ...s, code: read(s.file), thumb: svgDataUrl(read(s.id + '.thumb.svg')) }));

// ---- compile-probe tiap code (sama kayak install.ts probeTemplates) ----
let compile: ((code: string) => unknown) | null = null;
let validatePack: ((json: unknown) => { ok: true; pack: unknown } | { ok: false; errors: string[] }) | null = null;
try {
  const hostPath = join(here, '..', 'src', 'template-host.ts');
  const mod = await import(pathToFileURL(hostPath).href);
  compile = mod.compileTemplate;
  const valMod = await import(pathToFileURL(join(here, '..', 'src', 'plugins', 'validate.ts')).href);
  validatePack = valMod.validatePack;
} catch (e) {
  console.warn('⚠  import gagal, probe diskip:', (e as Error).message);
  console.warn('    fallback: cek statik (no import / no export default / punya Component).');
}
let okCount = 0;
for (const it of items) {
  if (compile) {
    try {
      compile(it.code);
      console.log(`✓ compile  ${it.id}`);
      okCount++;
    } catch (e) {
      console.error(`✗ compile  ${it.id}:`, (e as Error).message);
      process.exit(1);
    }
  } else {
    const code = it.code;
    const hasImport = /\bimport\s/.test(code) || /\brequire\s*\(/.test(code);
    const hasExportDefault = /export\s+default/.test(code);
    const hasComponent = /const\s+Component/.test(code);
    if (hasImport || hasExportDefault || !hasComponent) {
      console.error(`✗ static   ${it.id}: import/export/Component check failed`);
      process.exit(1);
    }
    console.log(`~ static   ${it.id}`);
    okCount++;
  }
}

const pack = {
  format: 'openchatcut-plugin@1',
  id: 'vox-explainer-motion',
  name: 'VOX Explainer Motion',
  version: '1.0.0',
  author: 'Willy',
  description: 'Five VOX-style explainer motion graphics: kinetic headline, big stat count-up, data bar grow, lower-third reveal, pull quote. Off-white paper, ink black, yellow accent, red alert, Inter display.',
  items: items.map(({ file, ...rest }) => ({ ...rest, type: 'mg-template' as const })),
};

if (validatePack) {
  const res = validatePack(pack);
  if (!res.ok) {
    console.error('✗ validatePack gagal:\n' + res.errors.map((m) => '    - ' + m).join('\n'));
    process.exit(1);
  }
  console.log('✓ validatePack OK');
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(pack, null, 2), 'utf8');
const kb = (JSON.stringify(pack).length / 1024).toFixed(1);
console.log(`\n✓ Wrote ${OUT}`);
console.log(`  ${pack.items.length} items, ${okCount}/${pack.items.length} compiled OK, ${kb} KB`);
