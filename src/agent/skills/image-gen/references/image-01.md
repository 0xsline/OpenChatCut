# MiniMax `image-01`

Read this before generating with `submit_image({ model: "image-01", … })`.

Grounded in OpenChatCut’s image adapter (`server/plugins/image.ts` → MiniMax). Only promise what our tool exposes.

## Capabilities (as wired)

| Dimension | Value |
| --- | --- |
| Model arg | `image-01` |
| Prompt | Required, **≤ 1500 characters** |
| Reference images | **0–1 subject image** via `subject_reference`; requires configured R2 temporary HTTPS URL |
| Count | **1–9** per call (default 1) |
| Aspect ratio | `1:1`, `16:9`, `4:3`, `3:2`, `2:3`, `3:4`, `9:16`, `21:9` |
| Custom dimensions | `width` + `height`, each 512–2048 and divisible by 8; omit aspect ratio |
| `imageSize` / `quality` | Not sent on this path |
| `seed` | Optional safe integer |
| `promptOptimizer` | Official default **false**; sent only when explicitly supplied |
| Server MiniMax model | From Settings `MINIMAX_IMAGE_MODEL` (`image-01` / `image-01-live`) |

## When to use

- MiniMax is configured and the user wants a still or a single subject-reference generation.
- User explicitly asked for MiniMax image generation.
- Only MiniMax image key is on (capabilities).

## When not to use

- Need multiple reference images → `nano-banana` or `gpt-image-2`
- Need best-in-class text-in-image → prefer `gpt-image-2`
- MiniMax key missing → say so; do not invent the model

## Tool shape

```ts
submit_image({
  model: "image-01",
  prompt: "…",                 // ≤1500 chars
  name: "Descriptive still",
  aspectRatio: "16:9",
  count: 1,                    // max 9
  seed: 42,
});

// Literal brand packshot (less auto-rewrite)
submit_image({
  model: "image-01",
  prompt: "Exact product bottle, white seamless, label text as written",
  name: "Bottle literal",
  promptOptimizer: false,
});
```

Pass at most one image in `referenceAssetIds`; R2 must be configured so MiniMax can fetch a temporary signed URL.

## Prompt tips

- Clear subject + style + lighting; avoid packing multi-scene storyboards into one still.
- Quote exact text if any lettering must appear (quality varies; gpt-image-2 is stronger for text).
- Keep the prompt under 1500 characters; split variants into separate calls if needed.
