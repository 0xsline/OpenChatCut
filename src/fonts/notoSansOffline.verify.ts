import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrowser, type HeadlessBrowser } from '@remotion/renderer';
import { FONT_CATALOG } from './googleFontCatalog';
import { findLocalFont } from './localFonts';

const localFace = findLocalFont('Noto Sans SC');
assert.ok(localFace, 'Noto Sans SC must resolve to an offline bundled face');
assert.equal(localFace.family, 'Noto Sans SC');
assert.equal(findLocalFont('Noto Sans CJK SC'), localFace, 'the historical English alias must stay compatible');
assert.equal(findLocalFont('思源黑体'), localFace, 'the historical Chinese alias must stay compatible');
assert.equal(localFace.stylesheet, '/fonts/noto-sans-sc/noto-sans-sc.css');
assert.deepEqual(localFace.weightRange, [100, 900], 'the variable face must preserve the 100–900 project weight range');

const catalogEntries = FONT_CATALOG.filter((entry) => entry.family === 'Noto Sans SC');
assert.equal(catalogEntries.length, 1, 'the font catalog must not expose duplicate remote and local entries');
assert.equal(catalogEntries[0]?.source, 'bundled', 'the font picker must report the offline source truthfully');

const fontRoot = resolve(fileURLToPath(new URL('../../assets/fonts/noto-sans-sc/', import.meta.url)));
const html = `<!doctype html>
<html><head><link rel="stylesheet" href="/fonts/noto-sans-sc/noto-sans-sc.css"></head>
<body><p style="font: 400 32px 'Noto Sans SC'">离线字体渲染 OpenChatCut 123</p></body></html>`;
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  const prefix = '/fonts/noto-sans-sc/';
  if (!pathname.startsWith(prefix)) {
    response.writeHead(404).end();
    return;
  }
  const candidate = resolve(fontRoot, pathname.slice(prefix.length));
  if (!candidate.startsWith(`${fontRoot}${sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const type = extname(candidate) === '.css' ? 'text/css; charset=utf-8' : 'font/woff2';
    response.writeHead(200, { 'Content-Type': type });
    response.end(readFileSync(candidate));
  } catch {
    response.writeHead(404).end();
  }
});

await new Promise<void>((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');

let browser: HeadlessBrowser | undefined;
try {
  browser = await openBrowser('chrome', { logLevel: 'error' });
  const page = await browser.newPage({
    context: () => null,
    logLevel: 'error',
    indent: false,
    pageIndex: 0,
    onBrowserLog: null,
    onLog: () => undefined,
  });
  await page.goto({ url: `http://127.0.0.1:${address.port}/`, timeout: 30_000 });
  type BrowserObservation = {
    faceCount: number;
    families: string[];
    weights: string[];
    styles: string[];
    checks: boolean[];
    rasters: string[];
  };
  const evaluateSource = String.raw`(async () => {
    const faces = [];
    document.fonts.forEach((face) => {
      if (face.family === 'Noto Sans SC') faces.push(face);
    });
    await Promise.all(faces.map((face) => face.load()));
    const rasters = [];
    for (const weight of [100, 400, 900]) {
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 110;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable');
      context.fillStyle = '#000';
      context.font = weight + ' 56px "Noto Sans SC"';
      context.fillText('离线字体渲染 OpenChatCut 123', 8, 72);
      rasters.push(canvas.toDataURL('image/png'));
    }
    return {
      faceCount: faces.length,
      families: [...new Set(faces.map((face) => face.family))],
      weights: [...new Set(faces.map((face) => face.weight))],
      styles: [...new Set(faces.map((face) => face.style))],
      checks: [100, 400, 900].map((weight) =>
        document.fonts.check(weight + ' 32px "Noto Sans SC"', '离线字体渲染 OpenChatCut 123')),
      rasters,
    };
  })()`;
  const evaluateString = page.evaluate as unknown as
    <T>(pageFunction: string) => Promise<T>;
  const observed = await evaluateString.call(page, evaluateSource) as BrowserObservation;
  assert.equal(observed.faceCount, 101, 'all bundled unicode-range faces must register in Chromium');
  assert.deepEqual(observed.families, ['Noto Sans SC']);
  assert.deepEqual(observed.weights, ['100 900']);
  assert.deepEqual(observed.styles, ['normal']);
  assert.deepEqual(observed.checks, [true, true, true], 'Chromium must load Noto at representative project weights');
  assert.equal(new Set(observed.rasters).size, 3, '100, 400 and 900 must produce distinct rendered glyph weights');
} finally {
  if (browser) await browser.close({ silent: true });
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

console.log('notoSansOffline.verify: Chromium loaded bundled Noto Sans SC at weights 100–900');
