---
name: image-gen
description: |
  AI image generation via gpt-image-2 and nano-banana. Use when the user wants to generate or create an image / picture / still through the backend image-generation jobs.
user-invocable: true
---

# Image Gen

Generate AI images through the backend generation API. Submit-only: creates a generation job and returns a `jobId`.

After submission, use `track_progress` tool to check status or wait for completion.

## Model Selection

| Model         | Strengths                                       | Max refs |
| ------------- | ----------------------------------------------- | -------- |
| `gpt-image-2` | Best text rendering, strongest prompt adherence | 10       |
| `nano-banana` | Strongest reference-image fidelity              | 14       |

- `gpt-image-2` is the default.
- `nano-banana` is the reference-heavy choice. Use it when reference-image fidelity matters more than text rendering, or when the user needs more than 10 reference images.

**IMPORTANT:** Before generating, READ the model's reference document for params, limits, and prompt tips:

- `gpt-image-2` → [references/gpt-image-2.md](references/gpt-image-2.md)
- `nano-banana` → [references/nano-banana.md](references/nano-banana.md)

## Tool Params

| Param               | Values                                                                  | Default |
| ------------------- | ----------------------------------------------------------------------- | ------- |
| `aspectRatio`       | `1:1`, `16:9`, `9:16`, `4:3`, `3:4`, `3:2`, `2:3`, `4:5`, `5:4`, `21:9` | `16:9`  |
| `imageSize`         | `1K`, `2K`, `4K`                                                        | `1K`    |
| `quality`           | `low`, `medium`, `high`, `auto` (gpt-image-2 only)                      | `high`  |
| `referenceAssetIds` | Array of project asset ids — backend resolves bytes server-side         | —       |
| `name`              | Short descriptive asset name shown in the library                       | —       |
| `count`             | Number of images to generate (1–10, each becomes a separate job)        | `1`     |

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
```

After submission, call the `track_progress` tool: `action=status jobIds=<jobId>` to poll, `action=wait jobIds=<jobId>` to block until terminal.

## Rules

- Always provide `name` with a short descriptive asset name.
- Default to submit-only. If there is no follow-up task, stop after submit and tell the user the job was created.
- Generation costs credits. Before submitting, briefly tell the user what you're about to generate — especially when generating multiple images.
- Do not use this skill for job management. Use `track_progress` tool for that.
