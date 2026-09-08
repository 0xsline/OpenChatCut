import assert from 'node:assert/strict';
import { generateOfoxVideo } from './ofox-video-provider.ts';
import { validateVideoRequest } from './video-validation.ts';

const input = validateVideoRequest({ model: 'ofox', prompt: 'paper airplane' });
const options = { ofoxBaseUrl: 'https://ofox.invalid/v1', ofoxApiKey: '', ofoxVideoModel: 'test-model' };
const originalFetch = globalThis.fetch;
const calls: Array<{ url: string; method?: string }> = [];
let response: unknown;
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: init?.method });
  return new Response(JSON.stringify(response), { status: 200 });
};
try {
  const registered: string[] = [];
  const register = async (_provider: string, id: string) => { registered.push(id); };
  await assert.rejects(generateOfoxVideo(input, options, register), /LLM_OFOX_API_KEY/);
  assert.equal(calls.length, 0, 'missing credentials must fail before sending media or a paid request');
  const configured = { ...options, ofoxApiKey: 'test-key' };
  for (const id of [undefined, null, {}, 42, '', '   ']) {
    response = { id };
    await assert.rejects(generateOfoxVideo(input, configured, register), /task id/);
  }
  assert.deepEqual(registered, [], 'malformed provider IDs must not mark a task as accepted');
  calls.length = 0;
  response = { status: 'completed', mirror_urls: ['https://ofox.invalid/saved.mp4'], unsigned_urls: ['https://ofox.invalid/temp.mp4'] };
  assert.equal(await generateOfoxVideo(input, configured, register, 'saved/id'), 'https://ofox.invalid/saved.mp4');
  assert.deepEqual(calls, [{ url: 'https://ofox.invalid/v1/videos/saved%2Fid', method: undefined }]);
  assert.deepEqual(registered, [], 'resuming polls the existing task without another paid submission');
} finally {
  globalThis.fetch = originalFetch;
}
console.log('ofox-video-provider.verify: credentials, task IDs and resume passed');
