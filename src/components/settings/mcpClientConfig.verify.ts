// Checks the 千问办公 paste-in snippet: it must be valid JSON, keep the bearer
// token in a header rather than the URL, and use the type that app's importer
// expects (which differs from the type the server-side writer emits).
import assert from 'node:assert/strict';
import { qwenWorkConnectJson, qwenWorkMcpConfig } from './mcpClientConfig';

const ENDPOINT = 'http://localhost:5199/api/external-mcp/mcp';
const TOKEN = 'tok_QWEN123-_abc';

const json = qwenWorkConnectJson(ENDPOINT, TOKEN);
const parsed = JSON.parse(json) as ReturnType<typeof qwenWorkMcpConfig>;
assert.deepEqual(parsed, qwenWorkMcpConfig(ENDPOINT, TOKEN), 'pretty-printed JSON round-trips');

const entry = parsed.mcpServers.openchatcut as { type: string; url: string; headers: { Authorization: string } };
assert.equal(entry.type, 'streamable-http');
assert.equal(entry.url, ENDPOINT);
assert.equal(entry.headers.Authorization, `Bearer ${TOKEN}`);
assert.ok(!json.includes('"' + ENDPOINT + '?'), 'token is not smuggled into the URL');
assert.ok(!/access_token|token=/.test(json), 'no query-param auth fallback in the snippet');

// Two different endpoints/tokens produce independent snippets.
const other = JSON.parse(qwenWorkConnectJson('http://localhost:5200/api/external-mcp/mcp', 'tok_OTHER')) as ReturnType<typeof qwenWorkMcpConfig>;
assert.notEqual(entry.url, (other.mcpServers.openchatcut as { url: string }).url);

console.log('✓ mcpClientConfig: 千问办公 snippet is valid JSON with bearer header auth');
