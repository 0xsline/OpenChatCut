# xAI Grok Imagine Video (`grok-imagine-video`)

Text-to-video via the xAI Grok Imagine Video family. Auth: the imported xAI
subscription session (SuperGrok / X Premium+) takes priority; otherwise the
`LLM_XAI_API_KEY` key. Configured model id comes from Settings
(`XAI_VIDEO_MODEL`), default `grok-imagine-video-1.5`.

## Wired capabilities

- **Text-to-video only.** No `firstFrame` / `lastFrame` / `refImages` /
  `refVideos` / `refAudios` / `refVideoMode` / `mode` / `shotType` /
  `multiPrompts` in this integration — validation rejects them. Do not send
  seedance/hailuo/kling-only controls (`generateAudio` etc.).
- **Duration** (`durationSeconds`): 1–15 seconds.
- **Aspect ratio** (`ratio`): `16:9` (default), `9:16`, `1:1`, `4:3`, `3:4`,
  `3:2`, `2:3`.
- **Resolution** (`resolution`): `480p` (default), `720p`, `1080p`.
- Generated videos **include an audio track by default** — no parameter
  needed; do not promise controllable audio.
- The job is asynchronous: `submit_video` returns a `jobId`; poll / wait with
  `track_progress` exactly like the other video vendors.

## Prompt guidance

One coherent action per clip. Include subject, motion, environment, lighting,
and camera intent; keep the scene physically continuous because the provider
generates a first frame and animates it.

## Errors

- 401/403 with a subscription session: the tier may not open the media API —
  suggest the API-key path or upgrading the subscription.
- `grok-imagine-video does not support ratio …` / `durationSeconds must be
  between 1 and 15`: fix the args, do not retry unchanged.
