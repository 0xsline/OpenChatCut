---
name: image-gen
description: |
  AI image generation via gpt-image-2, nano-banana, and MiniMax image-01. Use when the user wants to generate or create an image / picture / still.
user-invocable: true
---

# Image Gen

Generate AI images via `submit_image` (configured provider keys only). Prefer one clear still per request unless the user asked for variants.

## Model Selection

| Model | Reference | Strengths | Max refs |
| --- | --- | --- | --- |
| `gpt-image-2` | [references/gpt-image-2.md](references/gpt-image-2.md) | Best text rendering, strongest prompt adherence | 10 |
| `nano-banana` | [references/nano-banana.md](references/nano-banana.md) | Strongest reference-image fidelity | 14 |
| `image-01` | [references/image-01.md](references/image-01.md) | MiniMax stills; no reference images on this path | 0 |

- Default: `gpt-image-2` when that key is on.
- Reference-heavy → `nano-banana`.
- User named MiniMax / only MiniMax image key on → `image-01`.
- Respect capabilities: do not call a model whose vendor is not configured.

**IMPORTANT:** Before generating, READ the chosen model's reference.

## Tool Params

| Param               | Values                                                                  | Default |
| ------------------- | ----------------------------------------------------------------------- | ------- |
| `aspectRatio`       | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `4:5`, `5:4`, `21:9` | `16:9`  |
| `imageSize`         | `1K`, `2K`, `4K`                                                        | `1K`    |
| `quality`           | `low`, `medium`, `high`, `auto` (gpt-image-2 only)                      | `high`  |
| `referenceAssetIds` | Array of project asset ids — backend resolves bytes server-side         | —       |
| `name`              | Short descriptive asset name shown in the library                       | —       |
| `count`             | Number of images to generate (1–10; image-01 max 9)                     | `1`     |
| `promptOptimizer`   | MiniMax `image-01` only — `prompt_optimizer` (default true)             | `true`  |

## Defaults

- Aspect ratio: **16:9**. If the project composition is not 16:9, ASK the user which aspect ratio they want before generating.
- Size: **1K**.

## Ask Before Submit

- Never auto-upgrade size.
- Only pass `imageSize: "2K"` or `"4K"` when the user explicitly asks. Warn that 2K/4K are EXPERIMENTAL and may be slower.

## Reference Images

Use when the user provides source material to edit, blend, or use as visual guidance (e.g. "change the background", "combine these into a poster").

- Pass project asset ids via `referenceAssetIds`. The backend fetches and encodes them server-side — never pull the asset bytes yourself.
- When the user @-references an image asset, pass its id directly in `referenceAssetIds`.
- Formats accepted by backend: png, jpeg, webp, svg (auto-rasterized to png), heic, heif. Each ≤ 50MB.

## Run

```ts
// Basic generation
submit_image({
  model: "gpt-image-2",
  prompt: "a cute orange cat",
  name: "Cat",
});

// With quality (gpt-image-2 only)
submit_image({
  model: "gpt-image-2",
  prompt: "hero poster with bold title",
  quality: "high",
  name: "Hero Poster",
});

// With reference images — pass project asset ids; backend resolves bytes
submit_image({
  model: "gpt-image-2",
  prompt: "change background to beach",
  referenceAssetIds: ["<assetId>"],
  name: "Beach Edit",
});

// Reference-heavy with nano-banana
submit_image({
  model: "nano-banana",
  prompt: "composite poster",
  referenceAssetIds: ["<id1>", "<id2>"],
  name: "Composite",
});

// Multiple images
submit_image({
  model: "gpt-image-2",
  prompt: "product shots",
  count: 3,
  name: "Product",
});

// MiniMax (no reference images)
submit_image({
  model: "image-01",
  prompt: "matte product bottle on marble, soft studio light",
  name: "Bottle still",
});
```

OpenChatCut’s `submit_image` may return completed pool assets synchronously depending on the provider path. If a `jobId` is returned, use `track_progress`; otherwise treat the asset ids in the result as done.

## Rules

- Always provide `name` with a short descriptive asset name.
- Before submitting, briefly tell the user what you're about to generate — especially when generating multiple images.
- Only call models whose vendor key is configured (capabilities prompt).
