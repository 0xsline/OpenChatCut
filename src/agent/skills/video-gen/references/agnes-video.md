# Agnes Video (`agnes-video`)

Agnes Video 2.5 Flash. Configured model id comes from Settings
(`AGNES_VIDEO_MODEL`), default `agnes-video-2.5-flash`. Call this model only
when capabilities name Agnes Video.

## Wired capabilities

- **Duration**: integer seconds, 4–12. Omit to use 5.
- **Resolution**: `720p` only. Omit `resolution` or send `720p`.
- **Ratio**: `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `21:9`. Default `16:9`.
- **Text**: no frames and no references.
- **Frames**: `firstFrame` and/or `lastFrame`. Last frame may be used alone.
  Do not also send `refImages` or `refAudios`.
- **References**: up to 5 `refImages` and 3 `refAudios`, together or apart.
  No `refVideos`. In the prompt, refer to them as `<Picture 1>` and `<Audio 1>`
  (numbered from 1 inside each array).
- Optional `seed`. No multi-shot, generateAudio, camera, watermark, or Hailuo
  optimizer fields.

`submit_video` returns a `jobId`. Wait with `track_progress` before claiming
the asset exists.
