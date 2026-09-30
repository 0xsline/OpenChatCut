import assert from 'node:assert/strict';
import { execPublishTool, PUBLISH_TOOL_NAMES, PUBLISH_TOOL_SCHEMAS } from './publish-tools';
import { policyForTool } from '../execution-policy';
import { routedToolNames } from '../tool-routing';

interface Call { url: string; init?: RequestInit }
const calls: Call[] = [];
let responses: Array<() => Response> = [];
const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
  calls.push({ url: String(url), init });
  const next = responses.shift();
  assert(next, `unexpected fetch ${String(url)}`);
  return next();
}) as typeof fetch;

// ── schema contract ──
assert.deepEqual([...PUBLISH_TOOL_NAMES].sort(), ['publish_to_social', 'track_social_publish']);
const publishSchema = PUBLISH_TOOL_SCHEMAS.find((tool) => tool.name === 'publish_to_social');
assert.deepEqual(publishSchema?.input_schema.required, ['source', 'platforms', 'title']);
assert.match(publishSchema?.description ?? '', /WITHOUT confirm/);
assert.equal(policyForTool('publish_to_social').effect, 'irreversible_external', 'a public post is never auto-replayed');
assert.equal(policyForTool('track_social_publish').effect, 'read');
assert.ok(routedToolNames('publish this to TikTok and YouTube', false).has('publish_to_social'));
assert.ok(routedToolNames('把成片发布到抖音', false).has('publish_to_social'));

// ── preview: confirm defaults to false and the result tells the agent to stop and ask ──
responses = [json(200, { phase: 'preview', needsConfirm: true, requestId: 'ocut-1', missingPlatforms: ['linkedin'] })];
const preview = await execPublishTool('publish_to_social', {
  source: '/media/uploads/cut.mp4', platforms: ['tiktok', 'linkedin'], title: 'Hi',
}) as Record<string, unknown>;
const sent = JSON.parse(String(calls[0].init?.body));
assert.equal(calls[0].url, '/api/upload-post/publish');
assert.equal(sent.confirm, false, 'no confirm unless the agent passes it explicitly');
assert.equal(sent.aiGenerated, false);
assert.equal(preview.needsConfirm, true);
assert.match(String(preview.next), /only after they approve/);

// ── confirmed publish → poll hint; truthy-but-not-true confirm stays a preview ──
calls.length = 0;
responses = [json(200, { phase: 'preview', needsConfirm: true })];
await execPublishTool('publish_to_social', { source: '/media/uploads/cut.mp4', platforms: ['tiktok'], title: 'Hi', confirm: 'yes' });
assert.equal(JSON.parse(String(calls[0].init?.body)).confirm, false, 'only boolean true confirms');
responses = [json(200, { phase: 'submitted', requestId: 'ocut-2', status: 'queued', results: [] })];
const submitted = await execPublishTool('publish_to_social', {
  source: '/media/uploads/cut.mp4', platforms: ['tiktok'], title: 'Hi', confirm: true,
}) as Record<string, unknown>;
assert.equal(submitted.requestId, 'ocut-2');
assert.match(String(submitted.next), /track_social_publish/);

// ── dropped connection → never tell the agent to publish again ──
responses = [json(200, { phase: 'unconfirmed_delivery', requestId: 'ocut-3', status: 'unknown', results: [] })];
const dropped = await execPublishTool('publish_to_social', {
  source: '/media/uploads/cut.mp4', platforms: ['tiktok'], title: 'Hi', confirm: true,
}) as Record<string, unknown>;
assert.match(String(dropped.next), /Do NOT publish again/);

// ── server errors surface verbatim ──
responses = [json(412, { error: 'Upload-Post is not configured', code: 'upload_post_not_configured' })];
const unconfigured = await execPublishTool('publish_to_social', {
  source: '/media/uploads/cut.mp4', platforms: ['tiktok'], title: 'Hi',
}) as Record<string, unknown>;
assert.equal(unconfigured.code, 'upload_post_not_configured');
assert.match(String(unconfigured.error), /not configured/);

// ── tracking ──
calls.length = 0;
responses = [json(200, { requestId: 'ocut-2', status: 'completed', results: [{ platform: 'tiktok', status: 'completed' }] })];
const status = await execPublishTool('track_social_publish', { requestId: 'ocut-2' }) as Record<string, unknown>;
assert.equal(calls[0].url, '/api/upload-post/publish/ocut-2');
assert.equal(status.status, 'completed');
assert.deepEqual(await execPublishTool('track_social_publish', {}), { error: 'requestId is required' });

// wait with a zero budget returns the current state without sleeping, and explains a fresh not_found
responses = [json(200, { requestId: 'ocut-4', status: 'not_found', results: [] })];
const waited = await execPublishTool('track_social_publish', { requestId: 'ocut-4', action: 'wait', timeoutSeconds: 0 }) as Record<string, unknown>;
assert.equal(waited.waitExpired, true);
assert.match(String(waited.note), /few seconds to register/);

console.log('publish-tools.verify OK');
