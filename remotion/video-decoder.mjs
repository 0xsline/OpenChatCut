// Which decoder feeds video frames to the headless SERVER render (renderMedia /
// renderStill in chrome-headless-shell). The Player and the in-browser export
// never consult this: they always decode with @remotion/media.
//
// 'webcodecs' — @remotion/media <Video>: Mediabunny + the browser's WebCodecs
//   VideoDecoder, the same frame-accurate path the Player uses.
// 'offthread' — Remotion's <OffthreadVideo>: the bundled Rust/FFmpeg compositor
//   extracts each frame outside the browser.
//
// Windows defaults to 'offthread' (issue #162). Under the Windows render GL
// backend (angle → D3D11) Chrome can hand WebCodecs its D3D11 hardware decoder,
// whose small picture-buffer pool runs dry while Mediabunny holds decoded
// frames open; the decoder then stops producing output WITHOUT an error, so the
// "Extracting frame …" delayRender never clears and the export sits at ~10%
// until the ten-minute per-frame budget expires. Remotion reports the same hang
// with the exact versions this app ships (4.0.509, chrome-headless-shell
// 149.0.7790.0) and <OffthreadVideo> unaffected by it:
//   https://github.com/remotion-dev/remotion/issues/10701
//   https://github.com/remotion-dev/remotion/issues/11020 (fixed only in 4.0.521)
//   https://github.com/remotion-dev/remotion/issues/11393 (still open after it)
// macOS (VideoToolbox) and Linux keep 'webcodecs', so their render path — the
// one the macOS frame-sync CI job pins — does not change.
//
// CC_RENDER_VIDEO_DECODER=webcodecs|offthread overrides the default on any
// platform — a diagnosis switch in both directions, like CC_RENDER_GL.
//
// Keep this module dependency-free (bare `node` runs its verify).

/** @typedef {'webcodecs' | 'offthread'} ServerVideoDecoder */

/** @type {readonly ServerVideoDecoder[]} */
export const SERVER_VIDEO_DECODERS = Object.freeze(['webcodecs', 'offthread']);

/**
 * @param {{ platform?: string, override?: string | undefined }} [options]
 * @returns {ServerVideoDecoder}
 */
export function resolveServerVideoDecoder({
  platform = process.platform,
  override = process.env.CC_RENDER_VIDEO_DECODER,
} = {}) {
  const requested = typeof override === 'string' ? override.trim().toLowerCase() : '';
  if (requested === 'webcodecs' || requested === 'offthread') return requested;
  return platform === 'win32' ? 'offthread' : 'webcodecs';
}
