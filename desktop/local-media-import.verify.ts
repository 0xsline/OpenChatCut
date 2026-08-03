import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const moduleUrl = new URL('./local-media-import.ts', import.meta.url);
assert.equal(existsSync(moduleUrl), true, 'desktop local files need a direct import implementation');

if (existsSync(moduleUrl)) {
  const {
    hasAlphaPixelFormat,
    isTransparentMovProbe,
    transparentMovProxyArgs,
  } = await import(moduleUrl.href);

  assert.equal(hasAlphaPixelFormat('yuva444p10le'), true, 'ProRes 4444 alpha must be detected');
  assert.equal(hasAlphaPixelFormat('gbrap12le'), true, 'planar RGB alpha must be detected');
  assert.equal(hasAlphaPixelFormat('yuv420p'), false, 'ordinary video must stay opaque');
  assert.equal(
    isTransparentMovProbe({ codec_name: 'prores', profile: '4444', pix_fmt: 'yuva444p10le' }),
    true,
  );
  assert.equal(
    isTransparentMovProbe({ codec_name: 'prores', profile: '4444', pix_fmt: 'yuv444p10le' }),
    false,
    'profile alone must not proxy an opaque ProRes 4444 file',
  );
  assert.equal(
    isTransparentMovProbe({ codec_name: 'vp9', pix_fmt: 'yuv420p', tags: { alpha_mode: 1 } }),
    true,
    'explicit alpha metadata must be honored',
  );

  const args = transparentMovProxyArgs('/tmp/source.mov', '/tmp/proxy.webm');
  assert.deepEqual(
    args.slice(0, 8),
    ['-y', '-i', '/tmp/source.mov', '-map', '0:v:0', '-an', '-c:v', 'libvpx-vp9'],
  );
  assert.ok(args.includes('yuva420p'), 'proxy must preserve alpha');
  assert.ok(args.includes('alpha_mode=1'), 'proxy must label VP9 alpha for Chromium');
  assert.equal(args.includes('libx264'), false, 'H.264 would discard alpha');
}

const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const preloadSource = readFileSync(new URL('./preload.ts', import.meta.url), 'utf8');
assert.match(mainSource, /openchatcut:import-local-media/, 'main process must register direct local import');
assert.match(mainSource, /openchatcut:transparent-mov-proxy/, 'main process must register alpha proxying');
assert.match(preloadSource, /webUtils\.getPathForFile\(file\)/, 'preload must obtain native paths through Electron webUtils');

console.log('desktop local-media-import verification passed');
