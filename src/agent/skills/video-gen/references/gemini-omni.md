# Google Gemini Omni Flash (`gemini-omni`)

Video generation via Google’s Gemini Omni Flash Interactions API.
Auth: `GEMINI_API_KEY` (same key as Nano Banana image). Optional
`GEMINI_BASE_URL` (default `https://generativelanguage.googleapis.com`).
Configured model id comes from Settings (`GEMINI_OMNI_VIDEO_MODEL`),
default `gemini-omni-1.2-flash`.

## Wired capabilities

- **Text-to-video**, **image-to-video** (`firstFrame`), **first+last frame**
  interpolation, and up to **6 `refImages`** (mutually exclusive with frame
  anchors).
- **Not wired yet:** conversational multi-turn edit/extend
  (`previous_interaction_id`), uploaded `refVideos` / `refAudios`, Kling
  multi-shot / Seedance-only controls.
- **Aspect ratio** (`ratio`): `16:9` (default), `9:16` only.
- **Resolution** (`resolution`): `360p`, `720p` (default), `1080p`, `4k`.
- **Duration** (`durationSeconds`): optional whole seconds, 3–15, sent as the
  API's native `duration`. First+last frame interpolation allows 3–10. When
  omitted, Omni makes a 10-second video. A set duration overrides any length
  written in the prompt.
- Generated videos typically include audio; there is no separate audio toggle
  in this integration.
- The job is asynchronous from the agent’s point of view: `submit_video`
  returns a `jobId`; wait with `track_progress` like other vendors. The
  provider makes one Interactions request, then waits for Google to finish
  processing the result file before downloading it.

## Prompt guidance

Be concrete: subject, motion, environment, lighting, camera. For a single
continuous shot, say so explicitly (“single unbroken continuous shot, no cuts”).
Put negatives in the prompt (“no dialogue”, “no text overlays”).

## Errors

- Missing `GEMINI_API_KEY`: configure it under Settings → AI Generation → Video
  → Google · Gemini Omni Flash (or Image → Nano Banana).
- `gemini-omni does not support ratio …`: only `16:9` / `9:16`.
- Frame + `refImages` together: pick one mode; do not combine.
- `first+last frame interpolation supports durationSeconds 3 to 10`: shorten
  the clip or drop one of the frames.
