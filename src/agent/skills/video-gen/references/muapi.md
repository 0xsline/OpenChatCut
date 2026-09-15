# MuAPI

MuAPI is an asynchronous text-to-video provider. The configured endpoint selects
the concrete model; this integration defaults to the budget seedance-lite-t2v
endpoint.

## Configuration

- MUAPI_API_KEY — required.
- MUAPI_BASE_URL — optional; defaults to https://api.muapi.ai/api/v1.
- MUAPI_VIDEO_ENDPOINT — optional; defaults to seedance-lite-t2v.
- MUAPI_RESOLUTION — optional default resolution; 480p, 720p, or 1080p.

The official API contract uses x-api-key, accepts a POST to the selected
endpoint, returns a request_id, and exposes the result at
GET /predictions/{request_id}/result. See the
[MuAPI API reference](https://muapi.ai/docs/api-reference) and
[OpenAI-compatible endpoint documentation](https://muapi.ai/docs/openai-compatible)
for provider-side details.

## Supported request shape

- Text-to-video only; do not provide firstFrame, lastFrame, refImages,
  refVideos, or refAudios.
- durationSeconds: integer from 3 through 12.
- ratio: 16:9, 9:16, or 1:1.
- resolution: 480p, 720p, or 1080p.
- Do not send Seedance-only controls such as generateAudio, seed,
  cameraFixed, watermark, or task-expiration controls.

MuAPI jobs are paid asynchronous operations. A successful submission is
registered with its task ID so the server can resume polling after a restart.
If the POST response is ambiguous, do not retry automatically: the provider may
already have created a billable task.
