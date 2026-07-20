import assert from 'node:assert/strict';
import { WEB_TOOL_NAMES, WEB_TOOL_SCHEMAS } from './web-tools';

const names = WEB_TOOL_SCHEMAS.map((t) => t.name);
assert.deepEqual(
  names.sort(),
  ['web_batch_scrape', 'web_browser', 'web_crawl', 'web_map', 'web_search'].sort(),
);
for (const n of names) assert.ok(WEB_TOOL_NAMES.has(n));

const byName = Object.fromEntries(WEB_TOOL_SCHEMAS.map((t) => [t.name, t]));
assert.deepEqual((byName.web_browser!.input_schema as { required?: string[] }).required, ['url']);
assert.deepEqual((byName.web_search!.input_schema as { required?: string[] }).required, ['query']);
assert.deepEqual((byName.web_map!.input_schema as { required?: string[] }).required, ['url']);
assert.deepEqual((byName.web_crawl!.input_schema as { required?: string[] }).required, ['url']);
assert.deepEqual((byName.web_batch_scrape!.input_schema as { required?: string[] }).required, ['urls']);

console.log('web-tools.check: OK', names.join(', '));
