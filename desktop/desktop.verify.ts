// 桌面壳纯逻辑检查:env 解析 round-trip、mini-connect 前缀路由语义(插件挂载的
// 契约)、静态 MIME。跑法:npx tsx desktop/desktop.check.ts(已入 npm test 链)。
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseEnvText } from './env-file.ts';
import { createMiniConnect, matchRoute, rewriteUrl } from './mini-connect.ts';
import { staticMime } from './static-files.ts';

// ── env-file ────────────────────────────────────────────────────────────
{
  const env = parseEnvText([
    'LLM_API_KEY=sk-plain',
    'A_QUOTED="v#1"',
    "B_SINGLE='x y'",
    'C_COMMENT=val # trailing note',
    'D_EMPTY=',
    '# 整行注释',
    'not a kv line',
    '  E_SPACED =  padded  ',
  ].join('\n'));
  assert.equal(env.LLM_API_KEY, 'sk-plain');
  assert.equal(env.A_QUOTED, 'v#1', '成对引号剥离,内部 # 保留');
  assert.equal(env.B_SINGLE, 'x y');
  assert.equal(env.C_COMMENT, 'val', '未引号值截断于 #');
  assert.ok(!('D_EMPTY' in env), '空值不入 seed');
  assert.equal(env.E_SPACED, 'padded');
  console.log('env-file parse: OK');
}

// ── mini-connect 路由语义 ────────────────────────────────────────────────
{
  assert.equal(matchRoute('/export', '/export'), '/');
  assert.equal(matchRoute('/export', '/export/job'), '/job', '整段前缀命中');
  assert.equal(matchRoute('/export', '/exportx'), null, '非段界不命中');
  assert.equal(matchRoute('/', '/anything'), '/anything');
  assert.equal(rewriteUrl('/export/job?a=1', '/export/job'), '/?a=1', 'query 保留');
  assert.equal(rewriteUrl('/upload?name=x', '/upload'), '/?name=x');
  assert.equal(rewriteUrl('/media/uploads/%E4%B8%AD.mp4', '/media/uploads'), '/%E4%B8%AD.mp4');
  console.log('mini-connect match/rewrite: OK');
}

// ── mini-connect 分发:next 推进、url 重写/复原、404、异步失败兜 500 ──────
type FakeRes = ServerResponse & { statusCode: number; body: string; ended: boolean };
function fakeRes(): FakeRes {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0, body: '', ended: false, headersSent: false, writableEnded: false,
    setHeader: (k: string, v: string) => { headers[k] = v; },
    writeHead(code: number) { res.statusCode = code; (res as { headersSent: boolean }).headersSent = true; return res; },
    end(chunk?: string) { res.ended = true; (res as { writableEnded: boolean }).writableEnded = true; if (chunk) res.body += chunk; },
    on: () => res,
  };
  return res as unknown as FakeRes;
}
function fakeReq(url: string): IncomingMessage {
  return { url, method: 'GET', headers: {} } as unknown as IncomingMessage;
}

async function tick(): Promise<void> { await new Promise((r) => setTimeout(r, 0)); }

{
  const errors: unknown[] = [];
  const app = createMiniConnect((e) => errors.push(e));
  const seen: string[] = [];
  app.use('/a', (req, _res, next) => { seen.push(`a:${req.url}`); next(); });
  app.use('/a/b', (req, _res, next) => { seen.push(`ab:${req.url}`); next(); });
  app.use((req, res) => { seen.push(`root:${req.url}`); res.writeHead(200); res.end('done'); });

  const res = fakeRes();
  app.handle(fakeReq('/a/b/c?q=1'), res);
  assert.deepEqual(seen, ['a:/b/c?q=1', 'ab:/c?q=1', 'root:/a/b/c?q=1'], '逐层重写,兜底层见原 url');
  assert.equal(res.statusCode, 200);

  const res404 = fakeRes();
  const app2 = createMiniConnect(() => {});
  app2.use('/only', (_req, res2) => { res2.writeHead(200); res2.end(); });
  app2.handle(fakeReq('/other'), res404);
  assert.equal(res404.statusCode, 404, '无命中 → 404');

  const res500 = fakeRes();
  const app3 = createMiniConnect((e) => errors.push(e));
  app3.use('/boom', async () => { throw new Error('kaput'); });
  app3.handle(fakeReq('/boom'), res500);
  await tick();
  assert.equal(res500.statusCode, 500, '异步拒绝 → 500');
  assert.match(res500.body, /kaput/);
  assert.equal(errors.length, 1);
  console.log('mini-connect dispatch: OK');
}

// ── staticMime ──────────────────────────────────────────────────────────
{
  assert.equal(staticMime('index.html'), 'text/html; charset=utf-8');
  assert.equal(staticMime('app.js'), 'text/javascript', 'ES module 严格 MIME');
  assert.equal(staticMime('style.css'), 'text/css');
  assert.equal(staticMime('font.woff2'), 'font/woff2');
  assert.equal(staticMime('lut.cube'), 'text/plain; charset=utf-8');
  assert.equal(staticMime('clip.mp4'), 'video/mp4', '媒体走 media-dir 表');
  console.log('staticMime: OK');
}

console.log('\ndesktop.check: ALL PASSED');
