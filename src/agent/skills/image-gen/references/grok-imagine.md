# xAI Grok Imagine — Image (`grok-imagine`)

Text-to-image via the xAI Grok Imagine family. Auth: the imported xAI
subscription session (SuperGrok / X Premium+) takes priority; otherwise the
`LLM_XAI_API_KEY` key. Configured model id comes from Settings
(`XAI_IMAGE_MODEL`), default `grok-imagine-image-2.0`.

## Wired capabilities

- **Text-to-image only.** No reference images, no mask/edit controls in this
  integration — do not send `referenceAssetIds` / `maskAssetId` /
  `background` / `moderation` / `inputFidelity` / `outputFormat` /
  `outputCompression` / `seed` / `promptOptimizer` for this model.
- **Count**: 1–4 per call (`n`).
- **Aspect ratio** (`aspectRatio`): `1:1`, `16:9`, `9:16`, `4:3`, `3:4`,
  `3:2`, `2:3`. No `width`/`height`; do not send `imageSize` values other
  than `1K` (→ `1k`) or `2K` (→ `2k`). `512px` and `4K` are rejected.
- `quality` is ignored for this model.

## Prompt guidance

Single clear subject per request; the official docs recommend detailed scene
language (subject, action, environment, lighting, style). Outputs are
returned as temporary provider URLs; the app downloads them into the media
pool immediately.

## Errors

- 401/403 with a subscription session: the tier may not open the media API —
  suggest the API-key path or upgrading the subscription.
- `grok-imagine does not support aspect ratio …` / `imageSize must be 1K or 2K`:
  fix the args, do not retry unchanged.
