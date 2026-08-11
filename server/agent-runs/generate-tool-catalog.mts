import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ASK_MODE_TOOL_SCHEMAS } from '../../src/agent/ask-mode-tools.ts';
import { TOOL_SCHEMAS } from '../../src/agent/tools.ts';
import { serverToolCatalogForGeneration } from './tool-catalog-generation.ts';

const outputUrl = new URL('../../assets/agent/openchatcut-tool-schemas.json', import.meta.url);
const content = `${JSON.stringify({
  version: 1,
  edit: await serverToolCatalogForGeneration(TOOL_SCHEMAS),
  ask: await serverToolCatalogForGeneration(ASK_MODE_TOOL_SCHEMAS),
}, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = await readFile(outputUrl, 'utf8').catch(() => '');
  if (current !== content) {
    throw new Error('Server tool catalog is stale. Run npm run generate:server-tool-catalog.');
  }
  console.log('server tool catalog is current');
} else {
  await mkdir(fileURLToPath(new URL('.', outputUrl)), { recursive: true });
  await writeFile(outputUrl, content, 'utf8');
  console.log(`wrote ${fileURLToPath(outputUrl)}`);
}
