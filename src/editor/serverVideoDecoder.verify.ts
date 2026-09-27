// Which decoder a video layer uses (issue #162). Only a headless server render
// follows the server's choice; the Player and the in-browser export always keep
// @remotion/media, whatever the input props say.
// tsx --tsconfig tsconfig.app.json src/editor/serverVideoDecoder.verify.ts
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Internals } from 'remotion';
import {
  isServerVideoDecoder,
  offthreadTrimBefore,
  offthreadVideoTransparent,
  runtimeVideoDecoder,
  ServerVideoDecoderContext,
  useRuntimeVideoDecoder,
  WEBCODECS_FRAME_TOLERANCE_SECONDS,
  type ServerVideoDecoder,
  type VideoDecodeEnvironment,
} from './serverVideoDecoder';

const serverRender: VideoDecodeEnvironment = { isRendering: true, isClientSideRendering: false, isPlayer: false };
const player: VideoDecodeEnvironment = { isRendering: false, isClientSideRendering: false, isPlayer: true };
const browserExport: VideoDecodeEnvironment = { isRendering: true, isClientSideRendering: true, isPlayer: false };

assert.equal(runtimeVideoDecoder('offthread', serverRender), 'offthread', 'a server render follows the server');
assert.equal(runtimeVideoDecoder('webcodecs', serverRender), 'webcodecs');
assert.equal(runtimeVideoDecoder('offthread', player), 'webcodecs', 'the Player keeps @remotion/media');
assert.equal(runtimeVideoDecoder('offthread', browserExport), 'webcodecs',
  'the in-browser export keeps @remotion/media (web-renderer cannot run <OffthreadVideo>)');
assert.equal(runtimeVideoDecoder('offthread', serverRender, true), 'webcodecs',
  'browserRenderer compositions keep @remotion/media');
assert.equal(runtimeVideoDecoder('offthread', { ...serverRender, isRendering: false }), 'webcodecs',
  'nothing outside a render switches decoders');

/** What useRuntimeVideoDecoder returns under real Remotion environment and decoder contexts. */
function decoderIn(environment: VideoDecodeEnvironment, requested?: ServerVideoDecoder, browserRenderer = false) {
  let decoder: ServerVideoDecoder | undefined;
  function Probe() {
    decoder = useRuntimeVideoDecoder(browserRenderer);
    return null;
  }
  const probe = createElement(Probe);
  renderToStaticMarkup(createElement(
    Internals.RemotionEnvironmentContext.Provider,
    { value: { ...environment, isStudio: false, isReadOnlyStudio: false } },
    requested ? createElement(ServerVideoDecoderContext.Provider, { value: requested }, probe) : probe,
  ));
  return decoder;
}

assert.equal(decoderIn(serverRender), 'webcodecs', 'without a server choice every render keeps @remotion/media');
assert.equal(decoderIn(serverRender, 'offthread'), 'offthread');
assert.equal(decoderIn(player, 'offthread'), 'webcodecs');
assert.equal(decoderIn(browserExport, 'offthread'), 'webcodecs');
assert.equal(decoderIn(serverRender, 'offthread', true), 'webcodecs');

assert.equal(isServerVideoDecoder('offthread'), true);
assert.equal(isServerVideoDecoder('webcodecs'), true);
assert.equal(isServerVideoDecoder('ffmpeg'), false, 'unknown input props fall back to @remotion/media');
assert.equal(isServerVideoDecoder(undefined), false);

// The compositor is asked 1 ms later, expressed in timeline frames.
assert.equal(WEBCODECS_FRAME_TOLERANCE_SECONDS, 0.001);
assert.ok(Math.abs(offthreadTrimBefore(5, 30) - 5.03) < 1e-9);
assert.ok(Math.abs(offthreadTrimBefore(undefined, 60) - 0.06) < 1e-9);

assert.equal(offthreadVideoTransparent('/media/uploads/title.alpha.webm'), true, 'WebM keeps its alpha');
assert.equal(offthreadVideoTransparent('/media/uploads/TITLE.WEBM?v=2#t'), true);
assert.equal(offthreadVideoTransparent('/media/uploads/camera.mp4'), false, 'opaque footage keeps fast extraction');
assert.equal(offthreadVideoTransparent('/media/uploads/phone.mov'), false);
assert.equal(offthreadVideoTransparent('/media/uploads/clip.mp4?name=a.webm'), false);

console.log('serverVideoDecoder.verify: only server renders follow the server decoder; the Player and browser export keep @remotion/media');
