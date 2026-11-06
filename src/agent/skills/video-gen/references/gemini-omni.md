# Google Gemini Omni Flash (`gemini-omni`)

Video generation via Google’s Gemini Omni Flash Interactions API.
Auth: `GEMINI_API_KEY` (same key as Nano Banana image). Optional
`GEMINI_BASE_URL` (default `https://generativelanguage.googleapis.com`).
Configured model id comes from Settings (`GEMINI_OMNI_VIDEO_MODEL`),
default `gemini-omni-1.1-flash`.

## Wired capabilities

- **Text-to-video**, **image-to-video** (`firstFrame`), **first+last frame**
  interpolation, and up to **4 `refImages`** (mutually exclusive with frame
  anchors).
- **Not wired yet:** conversational multi-turn edit/extend
  (`previous_interaction_id`), uploaded `refVideos` / `refAudios`, Kling
  multi-shot / Seedance-only controls.
- **Aspect ratio** (`ratio`): `16:9` (default), `9:16` only.
- **Resolution** (`resolution`): `360p`, `720p` (default), `1080p`, `4k`.
- **Duration** (`durationSeconds`): optional 1–40. Omni has no native duration
  field — OpenChatCut folds the value into the prompt as a length hint when
  you send it. Prefer describing length in the prompt as well for reliability.
- Generated videos typically include audio; there is no separate audio toggle
  in this integration.
- The job is asynchronous from the agent’s point of view: `submit_video`
  returns a `jobId`; wait with `track_progress` like other vendors. The
  provider call itself is a single Interactions request (not a poll loop).

## Prompt guidance

Be concrete: subject, motion, environment, lighting, camera. For a single
continuous shot, say so explicitly (“single unbroken continuous shot, no cuts”).
Put negatives in the prompt (“no dialogue”, “no text overlays”).

## Errors

- Missing `GEMINI_API_KEY`: configure it under Settings → AI Generation → Video
  → Google · Gemini Omni Flash (or Image → Nano Banana).
- `gemini-omni does not support ratio …`: only `16:9` / `9:16`.
- Frame + `refImages` together: pick one mode; do not combine.
