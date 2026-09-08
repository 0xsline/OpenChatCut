// McpGuide must stay reachable only through its import thunk.
//
// A single static import anywhere pulls the dialog into an eager chunk and makes
// every lazy() built on loadMcpGuideDialog ineffective — not just the importer's
// own. TopBar.tsx did exactly that: the dashboard had a correct lazy wrapper and
// an idle prefetch, and both were dead because the editor's top bar imported the
// module directly. The only symptom was an INEFFECTIVE_DYNAMIC_IMPORT line in the
// build log, which does not fail the build, so it survived unnoticed.
//
// Bundler warnings are not a gate. This is.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const LOADER = 'src/components/settings/mcpGuideLoader.ts';

// Any import specifier whose final segment is McpGuide — './McpGuide',
// '../settings/McpGuide', with or without an extension.
const IMPORTS_MCP_GUIDE = /(?:from|import\s*\()\s*['"][^'"]*\/?McpGuide(?:\.tsx?)?['"]/;

const sources: string[] = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name)) sources.push(full);
  }
};
for (const top of ['src', 'server', 'shared', 'desktop']) walk(join(root, top));
assert.ok(sources.length > 500, `expected the source tree, found ${sources.length} files`);

const importers = sources
  .filter((file) => IMPORTS_MCP_GUIDE.test(readFileSync(file, 'utf8')))
  .map((file) => relative(root, file).split('\\').join('/'))
  .sort();

assert.deepEqual(
  importers,
  [LOADER],
  'McpGuide may only be imported by its thunk. A static import elsewhere silently '
  + `undoes the code splitting for every caller. Offenders: ${importers.join(', ')}. `
  + `Import loadMcpGuideDialog from ${LOADER} and wrap the dialog in lazy() + Suspense.`,
);

// Guard the guard: if the pattern ever stops matching, the assertion above would
// pass on an empty list and prove nothing.
assert.ok(
  IMPORTS_MCP_GUIDE.test(readFileSync(join(root, LOADER), 'utf8')),
  'the import pattern no longer matches the thunk itself, so this check is inert',
);

// The thunk is only worth protecting if the call sites actually defer through it.
for (const site of ['src/components/TopBar.tsx', 'src/components/dashboard/dashboardDialogs.tsx']) {
  const text = readFileSync(join(root, site), 'utf8');
  assert.match(text, /lazy\(\s*\(\)\s*=>\s*loadMcpGuideDialog\(\)/, `${site} must defer the dialog with lazy()`);
}

console.log('mcp guide loader checks passed (1 importer: the thunk)');
