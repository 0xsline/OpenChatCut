# MiniMax `image-01`

Read this before generating with `submit_image({ model: "image-01", … })`.

Grounded in OpenChatCut’s image adapter (`server/plugins/image.ts` → MiniMax). Only promise what our tool exposes.

## Capabilities (as wired)

| Dimension | Value |
| --- | --- |
| Model arg | `image-01` |
| Prompt | Required, **≤ 1500 characters** |
| Reference images | **Not supported** (server rejects any refs) |
| Count | **1–9** per call (default 1) |
| Aspect ratio | Passed through when set (same enum as other models; default `16:9`) |
| `imageSize` / `quality` | **Ignored** on this path (gpt-image-2 only for quality/size tiers) |
| `promptOptimizer` | Default **true** → API `prompt_optimizer`; set **false** for more literal prompts |
| Server MiniMax model | From Settings `MINIMAX_IMAGE_MODEL` (`image-01` / `image-01-live`) |

## When to use

- MiniMax is configured and the user wants a fast single-shot still without reference images.
- User explicitly asked for MiniMax image generation.
- Only MiniMax image key is on (capabilities).

## When not to use

- Need reference-image fidelity → `nano-banana` or `gpt-image-2`
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
});

// Literal brand packshot (less auto-rewrite)
submit_image({
  model: "image-01",
  prompt: "Exact product bottle, white seamless, label text as written",
  name: "Bottle literal",
  promptOptimizer: false,
});
```

Do **not** pass `referenceAssetIds` for `image-01`.

## Prompt tips

- Clear subject + style + lighting; avoid packing multi-scene storyboards into one still.
- Quote exact text if any lettering must appear (quality varies; gpt-image-2 is stronger for text).
- Keep the prompt under 1500 characters; split variants into separate calls if needed.
