# OFox Multi-Model Video (`ofox`)

Text-to-video via the OFox multi-model gateway (one API key in front of the
Seedance series, Wan, and other text-to-video models). Auth: the
`LLM_OFOX_API_KEY` key (shared with the OFox LLM preset). Configured model id
comes from Settings (`OFOX_VIDEO_MODEL`), default
`bytedance/seedance-2.0-fast`; any text-to-video model from the OFox catalog
(`GET /v1/models`) works.

## Wired capabilities

- **Text-to-video, image-to-video, first-and-last-frame, and image
  references.** `firstFrame` (optionally with `lastFrame`) anchors exact
  frames; up to 9 `refImages` guide subject/style instead. The two modes are
  **mutually exclusive** (the API rejects the combination). `refVideos` /
  `refAudios` are supported by the OFox API but not wired here yet;
  `refVideoMode` / `mode` / `shotType` / `multiPrompts` are rejected.
- **`generateAudio`** (default true for capable models) and **`seed`** pass
  through; seed determinism is not guaranteed by every upstream vendor.
- **Duration** (`durationSeconds`): 2–30 seconds locally; the API enforces the
  configured model's own range with a clear 400 before any task is created
  (for example the default model accepts 4–15 seconds).
- **Aspect ratio** (`ratio`): `16:9` (default), `9:16`, `1:1`, `4:3`, `3:4`,
  `3:2`, `2:3`, `21:9`, `9:21`.
- **Resolution** (`resolution`): `480p`, `720p` (default), `1080p` — per-model
  support is enforced by the API (the default model accepts 480p/720p).
- Project media rides as base64 data URLs; the OFox gateway re-hosts them on
  its own object storage before dispatching to the upstream model, so no
  public hosting is needed. Reference images should be reasonably sized
  (very small images can fail the upstream image validation).
- Results prefer `mirror_urls` (persistent signed CDN addresses, present when
  the upstream has mirroring enabled) and fall back to the temporary
  `unsigned_urls`.
- The job is asynchronous: `submit_video` returns a `jobId`; poll / wait with
  `track_progress` exactly like the other video vendors.

## Prompt guidance

One coherent action per clip. Include subject, motion, environment, lighting,
and camera intent. Different catalog models have different strengths; keep
prompts model-agnostic unless the user pinned a specific model.

## Errors

- `duration N out of range [a, b]` / `resolution "…" not supported`: the
  configured model's server-side limits — adjust the args or switch
  `OFOX_VIDEO_MODEL`, do not retry unchanged.
- 401 `upstream_auth_failed`: the OFox account key is invalid or out of
  balance — ask the user to check the key / top up.
