import assert from 'node:assert/strict';
import { ASK_MODE_TOOL_SCHEMAS } from '../../src/agent/ask-mode-tools.ts';
import { TOOL_SCHEMAS } from '../../src/agent/tools.ts';
import {
  canonicalServerRunToolCatalog,
  resolveServerRunToolCatalog,
} from './tool-policy.ts';
import { serverToolCatalogForGeneration } from './tool-catalog-generation.ts';

assert.deepEqual(
  canonicalServerRunToolCatalog(false),
  await serverToolCatalogForGeneration(TOOL_SCHEMAS),
);
assert.deepEqual(
  canonicalServerRunToolCatalog(true),
  await serverToolCatalogForGeneration(ASK_MODE_TOOL_SCHEMAS),
);
const requested = await serverToolCatalogForGeneration(TOOL_SCHEMAS.slice(0, 3));
assert.deepEqual(
  resolveServerRunToolCatalog(requested, false),
  requested,
  'canonical browser schemas resolve to server-owned schema objects',
);

const first = TOOL_SCHEMAS[0];
assert(first);
assert.throws(
  () => resolveServerRunToolCatalog([
    { ...first, description: `${first.description ?? ''} forged` },
  ], false),
  /Non-canonical or inactive/,
);
assert.throws(
  () => resolveServerRunToolCatalog([first, first], false),
  /Duplicate server run tool schema/,
);
assert.throws(
  () => resolveServerRunToolCatalog([{ name: 'unknown_tool', input_schema: {} }], false),
  /Non-canonical or inactive/,
);
const editOnly = TOOL_SCHEMAS.find((schema) => (
  !ASK_MODE_TOOL_SCHEMAS.some((candidate) => candidate.name === schema.name)
));
assert(editOnly, 'the edit catalog includes tools absent from Ask mode');
assert.throws(
  () => resolveServerRunToolCatalog([editOnly], true),
  /Non-canonical or inactive/,
  'Ask mode cannot smuggle an editing schema into the server catalog',
);

console.log('server run canonical tool policy verification passed');
