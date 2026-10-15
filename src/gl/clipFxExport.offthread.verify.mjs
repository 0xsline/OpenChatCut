// The effect/transition frame-sync fixture again, with every video layer —
// plain clips and GL effect inputs — decoded by the <OffthreadVideo> compositor:
// the decoder Windows server renders use (issue #162). macOS CI runs it at full
// strength, so the Windows path stays frame-synchronized without a Windows GPU.
// On Linux CI the GPU-less headless render gets no WebGL2 context under this
// decoder, so the effect can never apply there; Linux renders only use this
// decoder when CC_RENDER_VIDEO_DECODER forces it, and the macOS frame-sync job
// in ci.yml runs this file explicitly.
// node src/gl/clipFxExport.offthread.verify.mjs
if (process.platform === 'linux' && !!process.env.CI) {
  console.log('clipFxExport.offthread.verify: skipped on Linux CI (the macOS frame-sync job runs it)');
} else {
  process.env.CC_RENDER_VIDEO_DECODER = 'offthread';
  await import('./clipFxExport.verify.mjs');
}
