// search_content tool verify: URL construction, hit mapping, error paths.
// (The real Agent chain needs a dev server; this covers the handler logic.)
import assert from 'node:assert/strict';
import { execSearchTool } from './search-tools';

const calls: Array<{ url: string; headers: Record<string, string> }> = [];

function installFetch(respond: (url: string) => unknown): void {
  calls.length = 0;
  (globalThis as Record<string, unknown>).fetch = async (input: string | URL | Request) => {
    const url = String(input);
    calls.push({ url, headers: { 'sec-fetch-site': 'same-origin' } });
    const body = respond(url);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  };
}

async function main(): Promise<void> {
  // ── hit mapping ──
  installFetch(() => ({
    hits: [
      { kind: 'chat', projectId: 'p-1', ref: 'chat:p-1:2', score: -0.5 },
      { kind: 'caption', projectId: 'p-2', ref: 'project:p-2:captions', score: -1.2 },
    ],
  }));
  const result = await execSearchTool('search_content', { query: '背景音乐音量' });
  const hits = (result as { hits: Array<{ kind: string; where: string; score: number }> }).hits;
  assert.equal(hits.length, 2);
  assert.ok(calls[0]!.url.includes('/api/project-store/search?q='), 'must hit the search endpoint');
  assert.ok(calls[0]!.url.includes(encodeURIComponent('背景音乐音量')), 'query must be encoded');
  assert.equal(hits[0]!.kind, 'chat');
  assert.equal(hits[0]!.where, '工程 p-1 第 3 条消息', 'chat ref must map to a message position');
  assert.equal(hits[1]!.where, '工程 p-2 的字幕');
  assert.ok(hits[0]!.score >= hits[1]!.score, 'scores must descend');

  // ── project scoping + limit ──
  installFetch(() => ({ hits: [] }));
  await execSearchTool('search_content', { query: '转场', projectId: 'p-9', limit: 5 });
  assert.ok(calls[0]!.url.includes('project=p-9'), 'projectId must be appended');
  assert.ok(calls[0]!.url.includes('limit=5'), 'limit must be appended');

  // ── validation ──
  const missing = await execSearchTool('search_content', {});
  assert.equal((missing as { error: string }).error, 'query is required');
  const wrongName = await execSearchTool('search_fonts', { query: 'x' });
  assert.ok((wrongName as { error: string }).error.includes('unknown tool'));

  // ── fetch failure → friendly error ──
  (globalThis as Record<string, unknown>).fetch = async () => {
    throw new Error('network down');
  };
  const failed = await execSearchTool('search_content', { query: '字幕' });
  assert.equal((failed as { error: string }).error, 'network down');

  console.log('✓ search_content tool verify: URL/hits/errors all passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
