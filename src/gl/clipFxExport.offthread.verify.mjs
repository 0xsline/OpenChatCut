// The effect/transition frame-sync fixture again, with every video layer —
// plain clips and GL effect inputs — decoded by the <OffthreadVideo> compositor:
// the decoder Windows server renders use (issue #162). macOS CI runs it at full
// strength, so the Windows path stays frame-synchronized without a Windows GPU.
// node src/gl/clipFxExport.offthread.verify.mjs
process.env.CC_RENDER_VIDEO_DECODER = 'offthread';
await import('./clipFxExport.verify.mjs');
