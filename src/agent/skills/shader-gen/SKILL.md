---
name: shader-gen
description: |
  AI shader generator for WebGL video effects, transitions, masks, and color grading (LUT / 调色 / 电影感 / film look). Use when the user wants a video effect (滤镜 / 特效), a transition (转场 / crossfade / wipe / cube / 3d), a mask (蒙版 / 遮罩 / reveal), a zoom / push-in (推近 / 推镜头), or a color grade — try the built-in effects (zoom, builtin LUTs) before generating a new shader.
user-invocable: true
---

# Shader Generator

Submit-only: creates a backend generation job, returns `jobId`. Use the `track_progress` tool for job lifecycle after submission.

**Always use `generate.ts` for new shaders.** Manual authoring is only for editing existing asset code — never as a fallback when generation fails.

## Catalog-first rule — try existing assets before generation

Before generating a shader, call `browse_library` unless the user names an exact asset id that is already visible in `read_project`.

`browse_library` is the source of truth for built-in effects, built-in transitions, and project effect/transition assets. Built-ins are stable global asset ids, not per-project DB assets, so they may not appear in `read_project` asset lists.

Apply catalog entries with `edit_item`, do **not** call `submit_shader`.

Good catalog searches:

```text
browse_library(query: "zoom")
browse_library(category: "transitions", query: "dissolve")
browse_library(category: "audio-fx")
```

Generate only when no catalog entry matches the user's intent closely enough.

### `builtin:zoom` is track-bound only — DO NOT use item-bound

The default effect mode is `"item-bound"` (attach to a single item via `targetItemId`). **`builtin:zoom` does NOT render in item-bound mode** — the renderer reads zoom data exclusively from track-bound effect items. An item-bound zoom inserts into the DB silently but shows nothing in preview.

Use `mode: "track-bound"` with `trackId` + `trackBoundFrom` + `trackBoundDurationInFrames`. These three fields are required.

```text
# Zoom on the entire video clip
edit_item(json: '{"adds":[{"type":"effect","assetId":"builtin:zoom","mode":"track-bound","trackId":"<clip-trackId>","trackBoundFrom":<clip-fromFrame>,"trackBoundDurationInFrames":<clip-durationInFrames>,"propertyOverrides":{"magnification":1.5,"shape":"hold"}}]}')

# Zoom on a sub-range of the clip (e.g. frames 90–150 only, a punch zoom on a beat)
edit_item(json: '{"adds":[{"type":"effect","assetId":"builtin:zoom","mode":"track-bound","trackId":"<trackId>","trackBoundFrom":90,"trackBoundDurationInFrames":60,"propertyOverrides":{"magnification":2,"shape":"punch"}}]}')
```

Get `trackId` / `fromFrame` / `durationInFrames` from `read_project` (each video/image item lists its trackId and timeline-frame range).

| Key             | Type   | Range / values                             | Default | Notes                                          |
| --------------- | ------ | ------------------------------------------ | ------- | ---------------------------------------------- |
| `magnification` | number | 1–4                                        | `1.5`   | Zoom factor; 1 = no zoom, 2 = 2× in            |
| `focalPointX`   | number | 0–1                                        | `0.5`   | Horizontal focal point (0 = left, 1 = right)   |
| `focalPointY`   | number | 0–1                                        | `0.5`   | Vertical focal point (0 = top, 1 = bottom)     |
| `shape`         | select | `punch` / `hold` / `slow-push` / `instant` | `hold`  | Animation curve                                |
| `focalMode`     | select | `auto` / `manual`                          | `auto`  | `auto` picks subject; `manual` uses focalPoint |
| `easeInFrames`  | number | 0–60                                       | `8`     | Frames to ramp in                              |
| `easeOutFrames` | number | 0–60                                       | `8`     | Frames to ramp out                             |

Omit `propertyOverrides` entirely for default zoom. Send only the keys you want to change — patch semantics.

### Track-bound vs item-bound — the broader rule

Effect items in the schema have two modes:

- **`item-bound`** (default): `targetItemId` only. Effect covers the whole target item's playback. Works for shader effects, LUTs, color grades, blurs.
- **`track-bound`**: `trackId` + `trackBoundFrom` + `trackBoundDurationInFrames`. Effect covers a timeline range on a track, independent of any item. Required for `builtin:zoom`; also valid for any shader effect when you want it to cover a specific timeline range (e.g. a transition-like color shift across the boundary of two clips).

Default to item-bound for shader effects. Use track-bound when (a) the asset requires it (zoom), or (b) the effect should cover a timeline range that doesn't match a single item.

### Built-in LUT properties

```text
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<clip-id>","assetId":"builtin:slog3-s709","propertyOverrides":{"intensity":1}}]}')
```

| Key         | Type   | Range | Default | Notes                          |
| ----------- | ------ | ----- | ------- | ------------------------------ |
| `intensity` | number | 0–1   | `1`     | LUT strength; 1 = full applied |

To swap: delete the effect and re-add with a different `assetId`. To remove: delete the effect item.

These are separate from user-uploaded `.cube` LUT assets (see "Applying an Existing LUT Asset" below) — those use a different code path with `assetId:"lut"`.

## Beta Status Gate

New shader generation is beta. Before generating, warn the user and wait for explicit confirmation.

Use the user's language. Chinese: "新的特效/转场生成目前还是 beta 阶段，可能会有不稳定的问题。如果你坚持要做，我可以帮你实现。" Skip if user already acknowledged in the same request.

## Supported Targets

Effects and transitions apply to `video`, `image`, and `gif` items.

## Type Routing

Before generating anything, check two non-generation paths first:

1. **Catalog entry** — use `browse_library` for built-in and project effects/transitions.
2. **User-uploaded `.cube` LUT asset** that already exists in the project library — separate code path, see "Applying an Existing LUT Asset" below. The asset shows up in `read_project` with `type: lut`.

| User wants                                                           | `--type`     |
| -------------------------------------------------------------------- | ------------ |
| Video appearance (color, blur, glow, grain, distortion)              | `effect`     |
| Color grade / look (teal-orange, cinematic, vintage, LUT-style)      | `effect`     |
| Visibility control (mask, reveal, wipe, shape cutout, gradient fade) | `effect`     |
| Blend between clips (crossfade, dissolve, slide, 3D cube/page flip)  | `transition` |

"LUT-style" in the table means **generating a fresh GLSL color grade that resembles a LUT** — only when the user wants something new. If they want to apply a `.cube` file already in the library, don't generate; bind the existing asset instead.

No separate LUT or mask generator for the generation path — those are all `effect`.

## Applying an Existing LUT Asset

`.cube` files uploaded by the user become `lut` assets. Applying one to a clip is **not** generation — it's a single `edit_item` call that attaches an effect item whose `assetId` is the literal string `"lut"` and whose `propertyOverrides.lut` binds the real LUT asset id. (Legacy contract; the unified LUT API binds the LUT effect asset id directly — see `edit_item` description.)

```text
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<clip-id>","assetId":"lut","propertyOverrides":{"intensity":1,"lut":{"assetId":"<lut-asset-id>","assetType":"lut","type":"asset"}}}]}')
```

Key points:

- `assetId` is the literal string `"lut"`, not the LUT asset's id. The real LUT asset id goes inside `propertyOverrides.lut.assetId`.
- `intensity` is 0–1; default 1 (full strength).
- `targetItemType` defaults to `video`; also supports `image`, `gif`.
- To swap a LUT on an existing effect: update `propertyOverrides.lut.assetId` to the new LUT asset id.
- To remove: delete the effect item.

Do not call `generate.ts` for this path. Do not pass a real LUT asset id as `assetId` — the editor checks `assetId === "lut"` to route into the LUT renderer; passing a UUID silently renders nothing.

## Usage

Before calling `submit_shader`, restate the user's intent in one concrete sentence, then proceed immediately. After `track_progress` returns, state what was produced in one line — do NOT ask "要保留还是重新生成".

```ts
submit_shader({
  type: "effect",
  prompt: "Chromatic aberration with RGB split",
  name: "Chromatic Aberration",
});

submit_shader({
  type: "transition",
  prompt: "Smooth crossfade with soft edge",
  name: "Crossfade",
});

submit_shader({
  type: "effect",
  prompt: "Cinematic teal-orange color grade",
});

submit_shader({
  type: "effect",
  prompt: "Stronger version",
  referenceAssetIds: ["effect_asset_id"],
});
```

## Strategy

- Submit, then stop. Tell user the job was created.
- Use the `track_progress` tool for status/wait after submission.
- Generation always produces a library asset — never refuse because the timeline isn't ready.
- **Apply is separate and optional.** Only apply when user explicitly asks ("加到视频", "apply", "用到第一段"). When ambiguous, default to library-only.

## Editing Existing Properties

Any time you're about to edit shader `asset.properties`, applied effect/transition `item.propertyOverrides`, or promote a hardcoded shader value, read [`references/property-changes.md`](references/property-changes.md) first.

It reinforces that shader `properties` is an array, but the allowed shader property types are only `number`, `boolean`, `color`, `select`, and `vec2`. Motion Graphic properties are also arrays, but use a different type set.

## Parameters

| Param               | Description                                                                                                                                                    | Default |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `type`              | `"effect"` or `"transition"` (req'd)                                                                                                                           | —       |
| `prompt`            | Description of the shader (req'd)                                                                                                                              | —       |
| `name`              | Asset name shown in library                                                                                                                                    | —       |
| `referenceAssetIds` | Asset ids. Image id → model LOOKS AT it for visual inspiration. Effect/transition id → reuse its code as style anchor (≤1 per submit, kind must match `type`). | —       |

## Output

Returns `{ success, job: { jobId, status }, manage: { status, wait, watch } }`.

## Applying to Timeline

Only when user explicitly requests. Call `read_project` first for fresh timeline state.

### Effect

```text
edit_item(json: '{"adds":[{"type":"effect","targetItemId":"<id>","assetId":"<id>","enabled":true,"propertyOverrides":{}}]}')
```

### Transition

Requires two adjacent same-track endpoints. `edit_item` validates live seam feasibility and refuses durations that would require freeze frames or overlapping neighboring transitions. If the add fails, retry with the suggested `durationInFrames`, trim the clips to expose handles, delete/shorten neighboring transitions, or keep a hard cut.

```text
edit_item(json: '{"adds":[{"type":"transition","assetId":"<id>","outgoingItemId":"<id1>","incomingItemId":"<id2>","durationInFrames":30}]}')
```

## Validation & Verification

### Backend Validation

When generating via `generate.ts`, the backend handles validation automatically (transpile, AST security, class structure, retry on failure).

### Manual Code Verification

**NEVER write shader code from scratch.** Always use `generate.ts` for new shaders. This section is ONLY for modifying existing shader code that was already generated.

When writing shader code manually, read `${CLAUDE_SKILL_DIR}/references/design-principles.md` first. If the change touches editable properties, also read `${CLAUDE_SKILL_DIR}/references/property-changes.md`.

Typical workflow:

1. `read_project` with the shader `assetId` and `code: true` — read the current source.
2. Edit the source in your own context.
3. `edit_asset` with `action=update`, the same `assetId`, and the full replacement source inline in `json.code`. Validation runs automatically on update — if code is invalid, the update is rejected with error details.
