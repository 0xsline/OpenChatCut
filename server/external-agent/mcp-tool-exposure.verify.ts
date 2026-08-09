import assert from 'node:assert/strict';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  activatedMcpToolNames,
  activateMcpToolExposure,
  initialMcpToolExposure,
  projectMcpToolExposure,
  requestedMcpToolExposure,
} from './mcp-tool-exposure.ts';
const controls = { openchatcut_status: true } as const;

assert.equal(requestedMcpToolExposure({
  url: '/api/external-mcp/mcp',
  headers: {},
} as never), 'full');
assert.equal(requestedMcpToolExposure({
  url: '/api/external-mcp/mcp?toolExposure=progressive',
  headers: {},
} as never), 'progressive');
assert.equal(requestedMcpToolExposure({
  url: '/api/external-mcp/mcp',
  headers: { 'x-openchatcut-tool-exposure': 'progressive' },
} as never), 'progressive');
const catalog: Tool[] = [
  { name: 'openchatcut_status', inputSchema: { type: 'object' } },
  { name: 'ToolSearch', inputSchema: { type: 'object' } },
  { name: 'load_skill', inputSchema: { type: 'object' } },
  { name: 'read_project', inputSchema: { type: 'object' } },
  { name: 'submit_export', inputSchema: { type: 'object' } },
  { name: 'edit_captions', inputSchema: { type: 'object' } },
];

const full = initialMcpToolExposure('full');
assert.deepEqual(projectMcpToolExposure(full, catalog, controls), catalog);

const first = initialMcpToolExposure('progressive');
assert.deepEqual(
  projectMcpToolExposure(first, catalog, controls).map((tool) => tool.name),
  ['openchatcut_status', 'ToolSearch', 'load_skill', 'read_project'],
);
const searched = activateMcpToolExposure(first, 'ToolSearch', {
  results: [{ name: 'submit_export' }, { name: 'not_a_tool' }],
}, catalog, 10);
assert.equal(searched.revision, first.revision + 1);
assert.deepEqual(searched.lastActivation, {
  source: 'tool_search', names: ['submit_export'], at: 10,
});
assert.equal(
  projectMcpToolExposure(searched, catalog, controls)
    .some((tool) => tool.name === 'submit_export'),
  true,
);

const loaded = activateMcpToolExposure(first, 'load_skill', {
  skill: 'export',
  contents: {
    'SKILL.md': 'Read captions with read_project, then call edit_captions. Do not call submit_export.',
  },
}, catalog, 20);
assert.deepEqual(loaded.lastActivation, {
  source: 'load_skill', names: ['submit_export', 'edit_captions'], at: 20,
});
assert.deepEqual(
  activatedMcpToolNames('load_skill', {
    contents: { 'SKILL.md': 'Use edit_captions and submit_export.' },
  }, catalog),
  ['submit_export', 'edit_captions'],
);
assert.equal(first.names.includes('edit_captions'), false, 'session exposure is immutable');

const unchanged = activateMcpToolExposure(loaded, 'load_skill', {
  contents: { 'SKILL.md': 'No catalog names here.' },
}, catalog, 30);
assert.equal(unchanged, loaded, 'empty activation does not cause list_changed churn');

console.log('MCP progressive tool exposure verification passed');
