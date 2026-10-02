import assert from 'node:assert/strict';
import { execPublishTool, PUBLISH_TOOL_NAMES, PUBLISH_TOOL_SCHEMAS, trackSocialPublish, type TrackDeps } from './publish-tools';
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
const SOURCE = { source: '/media/uploads/cut.mp4', platforms: ['tiktok'], title: 'Hi' };
const lastBody = () => JSON.parse(String(calls[calls.length - 1].init?.body)) as Record<string, unknown>;

// ── schema contract ──
assert.deepEqual([...PUBLISH_TOOL_NAMES].sort(), ['publish_to_social', 'track_social_publish']);
const publishSchema = PUBLISH_TOOL_SCHEMAS.find((tool) => tool.name === 'publish_to_social');
assert.deepEqual(publishSchema?.input_schema.required, ['source', 'platforms', 'title']);
assert.match(publishSchema?.description ?? '', /WITHOUT confirm/);
assert.match(publishSchema?.description ?? '', /previewId set to that requestId/);
assert.ok(publishSchema?.input_schema.properties?.previewId, 'previewId is part of the schema');
assert.equal(policyForTool('publish_to_social').effect, 'irreversible_external', 'a public post is never auto-replayed');
assert.equal(policyForTool('track_social_publish').effect, 'read');
assert.ok(routedToolNames('publish this to TikTok and YouTube', false).has('publish_to_social'));
assert.ok(routedToolNames('把成片发布到抖音', false).has('publish_to_social'));

// ── preview: confirm defaults to false and the result tells the agent to stop, ask, and bind the confirm ──
responses = [json(200, { phase: 'preview', needsConfirm: true, requestId: 'ocut-1', missingPlatforms: [] })];
const preview = await execPublishTool('publish_to_social', SOURCE) as Record<string, unknown>;
assert.equal(calls[0].url, '/api/upload-post/publish');
assert.equal(lastBody().confirm, false, 'no confirm unless the agent passes it explicitly');
assert.equal(lastBody().aiGenerated, false);
assert.equal(preview.needsConfirm, true);
assert.match(String(preview.next), /previewId set to this requestId/);
assert.ok(calls[0].init?.signal, 'the publish request is time-bounded');

// ── only boolean true confirms, and the previewId is forwarded ──
responses = [json(200, { phase: 'preview', needsConfirm: true })];
await execPublishTool('publish_to_social', { ...SOURCE, confirm: 'yes' });
assert.equal(lastBody().confirm, false);
responses = [json(200, { phase: 'admitted', requestId: 'ocut-1', status: 'uploading', results: [] })];
const admitted = await execPublishTool('publish_to_social', { ...SOURCE, confirm: true, previewId: 'ocut-1' }) as Record<string, unknown>;
assert.equal(lastBody().previewId, 'ocut-1');
assert.equal(admitted.phase, 'admitted');

// ── the Pinterest board travels from the tool call to the server ──
assert.ok(publishSchema?.input_schema.properties?.pinterestBoardId, 'pinterestBoardId is part of the schema');
responses = [json(200, { phase: 'preview', needsConfirm: true, requestId: 'ocut-p' })];
await execPublishTool('publish_to_social', { ...SOURCE, platforms: ['pinterest'], pinterestBoardId: 'board-42' });
assert.equal(lastBody().pinterestBoardId, 'board-42');
assert.match(String(admitted.next), /background/);

// ── [P1] a changed profile / file / field surfaces as "preview again", never a silent publish ──
responses = [json(409, { error: 'changed since the preview', code: 'preview_mismatch' })];
const mismatch = await execPublishTool('publish_to_social', { ...SOURCE, confirm: true, previewId: 'ocut-1' }) as Record<string, unknown>;
assert.equal(mismatch.code, 'preview_mismatch');
assert.match(String(mismatch.next), /fresh preview/);

// ── ambiguous delivery → never tell the agent to publish again ──
responses = [json(200, { phase: 'unconfirmed_delivery', requestId: 'ocut-3', status: 'unknown', results: [] })];
const dropped = await execPublishTool('publish_to_social', { ...SOURCE, confirm: true, previewId: 'ocut-3' }) as Record<string, unknown>;
assert.match(String(dropped.next), /will NOT be re-sent/);
responses = [json(200, { phase: 'preview', needsConfirm: true, requestId: 'ocut-3', previouslySubmitted: true })];
const repeatPreview = await execPublishTool('publish_to_social', SOURCE) as Record<string, unknown>;
assert.match(String(repeatPreview.next), /already sent/, 'no second confirmation prompt for a publish already sent');

// ── a confirm that times out on the local route points to tracking, not to confirming again ──
responses = [() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }];
const timedOut = await execPublishTool('publish_to_social', { ...SOURCE, confirm: true, previewId: 'ocut-5' }) as Record<string, unknown>;
assert.equal(timedOut.requestId, 'ocut-5');
assert.match(String(timedOut.next), /Do not confirm again/);

// ── server errors surface verbatim ──
responses = [json(412, { error: 'Upload-Post is not configured', code: 'upload_post_not_configured' })];
const unconfigured = await execPublishTool('publish_to_social', SOURCE) as Record<string, unknown>;
assert.equal(unconfigured.code, 'upload_post_not_configured');

// ── tracking ──
calls.length = 0;
responses = [json(200, { requestId: 'ocut-2', status: 'completed', results: [{ platform: 'tiktok', status: 'completed' }] })];
const status = await execPublishTool('track_social_publish', { requestId: 'ocut-2' }) as Record<string, unknown>;
assert.equal(calls[0].url, '/api/upload-post/publish/ocut-2');
assert.equal(status.status, 'completed');
assert.ok(calls[0].init?.signal, 'even a single status read is time-bounded');
assert.deepEqual(await execPublishTool('track_social_publish', {}), { error: 'requestId is required' });

// ── [P3] every status request is bounded by the remaining wait budget (virtual clock) ──
// The review's reproduction: each status answer takes 15 s, timeoutSeconds is 20.
function virtualClock(responseMs: number, body: Record<string, unknown>) {
  let clock = 0;
  const timers: Array<{ at: number; controller: AbortController }> = [];
  const requestsAt: number[] = [];
  const deps: TrackDeps = {
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    timeoutSignal: (ms) => {
      const controller = new AbortController();
      timers.push({ at: clock + ms, controller });
      return controller.signal;
    },
    fetch: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      requestsAt.push(clock);
      const respondAt = clock + responseMs;
      const timer = timers.find((entry) => entry.controller.signal === init?.signal);
      if (timer && timer.at < respondAt) {
        clock = timer.at;
        timer.controller.abort();
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      }
      clock = respondAt;
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch,
  };
  return { deps, elapsed: () => clock, requestsAt };
}
const slow = virtualClock(15_000, { requestId: 'ocut-9', status: 'processing', results: [] });
const bounded = await trackSocialPublish({ requestId: 'ocut-9', action: 'wait', timeoutSeconds: 20 }, slow.deps) as Record<string, unknown>;
assert.ok(slow.elapsed() <= 20_000, `the wait honours timeoutSeconds (took ${slow.elapsed()} ms of virtual time)`);
assert.equal(bounded.waitExpired, true);
assert.equal(bounded.status, 'processing', 'the last known status is returned when the budget runs out');
assert.deepEqual(slow.requestsAt, [0, 18_000], 'second request is cut off at the 20 s budget, not left to run 15 s');

const hung = virtualClock(60_000, { requestId: 'ocut-9', status: 'processing', results: [] });
const firstHangs = await trackSocialPublish({ requestId: 'ocut-9', action: 'wait', timeoutSeconds: 20 }, hung.deps) as Record<string, unknown>;
assert.equal(hung.elapsed(), 20_000, 'a hung first request is aborted exactly at the budget');
assert.equal(firstHangs.waitExpired, true);
assert.equal(firstHangs.status, 'unknown', 'no status was ever read');

const fast = virtualClock(100, { requestId: 'ocut-9', status: 'uploading', results: [] });
const maxed = await trackSocialPublish({ requestId: 'ocut-9', action: 'wait', timeoutSeconds: 999 }, fast.deps) as Record<string, unknown>;
assert.ok(fast.elapsed() <= 25_000, 'the wait is capped below the 30 s tool deadline');
assert.equal(maxed.status, 'uploading');
assert.equal(maxed.waitExpired, true);

const settled = virtualClock(100, { requestId: 'ocut-9', status: 'unknown', results: [], note: 'will not be re-sent' });
const unknown = await trackSocialPublish({ requestId: 'ocut-9', action: 'wait', timeoutSeconds: 20 }, settled.deps) as Record<string, unknown>;
assert.equal(settled.requestsAt.length, 1, 'an ambiguous outcome is reported at once instead of polled for the whole budget');
assert.equal(unknown.status, 'unknown');

console.log('publish-tools.verify OK');
