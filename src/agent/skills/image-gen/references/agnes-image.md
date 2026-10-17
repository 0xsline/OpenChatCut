# Agnes Image (`agnes-image`)

Text-to-image and image-to-image via Agnes Image. The configured model id comes
from Settings (`AGNES_IMAGE_MODEL`), default `agnes-image-2.5-flash`. Call this
model only when capabilities name Agnes Image. Do not send `gpt-image-2`.

## Wired capabilities

- **Text or references.** Up to 8 project images in `referenceAssetIds`.
  No mask, background, moderation, fidelity, output format, seed, quality, or
  custom `width`/`height`.
- **Count**: 1–4. Each output is a separate request.
- **Aspect ratio**: `1:1`, `3:4`, `4:3`, `16:9`, `9:16`, `2:3`, `3:2`, `21:9`.
- **Size**: `1K`, `2K`, `3K`, or `4K`. Default `1K`. Do not send `512px`.

## Prompt guidance

Name the subject, scene, style, lighting, and what must stay unchanged when
references are attached. The first reference is the main subject unless the
prompt says otherwise.
