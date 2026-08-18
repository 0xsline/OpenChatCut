# Sonilo (`provider: "sonilo"`)

OpenChatCut wires the Sonilo video-to-music API (`/v1/video-to-music` → poll `/v1/tasks/{task_id}`). There is no model field: `/v1` always routes to the latest model server-side.

## Mode

| Mode | Input | Key controls |
| --- | --- | --- |
| `v2m` | project **video** `sourceAssetId` (the rendered cut, ≤6 minutes) | optional `prompt` ≤500 (single style hint; works promptless) |

The video is uploaded server-side and the music is composed from the cut itself — pacing, scene changes, and emotional arc come from the footage, not from a text description. Exactly one `.m4a` result per job.

## Rights

Generated music is licensed and safe for commercial use (terms apply). Every track returns a `license_id`, surfaced as `licenseId` on the generation result and archived as a `.license.json` sidecar beside the audio file in the media uploads directory — keep it for commercial-use review.

## Rules

- `sourceAssetId` must resolve to a project **video** upload; images and audio are rejected.
- `count` is fixed at 1; `lyrics`, styles, stems, segment ranges, and audio-format controls belong to other providers and are rejected.
- Prompt is a style hint only ("warm indie folk, no drums"), not a scene description — the model already sees the video.
- Videos longer than 6 minutes fail fast locally before upload; trim or export a shorter cut first.
- The same `SONILO_API_KEY` also enables `submit_sound` with `provider: "sonilo"`: royalty-free sound effects generated from a project video asset (≤3 minutes), no prompt.
