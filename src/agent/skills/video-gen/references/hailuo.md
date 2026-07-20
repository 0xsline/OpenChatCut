# MiniMax Hailuo (`hailuo`)

Read this before `submit_video({ model: "hailuo", … })`.

Grounded in OpenChatCut’s video adapter (`server/plugins/video.ts` → MiniMax
`POST /v1/video_generation`, poll `query/video_generation`, download via
`files/retrieve`). Official MiniMax video guide lists four product modes
(T2V / I2V / first–last / subject-reference). **This path implements T2V,
single-image I2V, and first+last frames.** Subject-reference and multi-ref
are not wired.

Default settings model is `MiniMax-Hailuo-02` (Settings may switch to
`MiniMax-Hailuo-2.3` / `MiniMax-Hailuo-2.3-Fast`). Call it **海螺 / Hailuo /
MiniMax video** for the user.

## Capabilities (as wired)

| Dimension | Value |
| --- | --- |
| Endpoint | `POST {MINIMAX_BASE_URL}/v1/video_generation` |
| Duration | **Exactly `6` or `10`** seconds (default **6**) |
| Resolution tool args | `720p` (default) → API **`768P`** · `1080p` → API **`1080P`** |
| Aspect ratio | **No `ratio` field** — not sent. Framing follows first-frame image when present |
| Prompt | **Required**, ≤ **2000** characters |
| Prompt optimizer | Default **`true`**; tool `promptOptimizer: false` for more literal prompts |
| Fast pretreatment | Optional `fastPretreatment: true` when optimizer is on |
| Audio | Provider-side; no tool toggle |
| Multi-shot / Kling fields | **Rejected** |
| Async | Submit → poll ~**10s** → `file_id` → download URL |

### Duration × resolution matrix

| Tool `resolution` | API value | Allowed `durationSeconds` |
| --- | --- | --- |
| `720p` (default) | `768P` | **6** or **10** |
| `1080p` | `1080P` | **6 only** (10s rejected by our validator) |

If you need 10s, use `720p` (or omit resolution).

## Input channels

| Tool param | Wired? | Maps to API |
| --- | --- | --- |
| `prompt` | **Yes, required** | `prompt` |
| `firstFrame` | Optional | `first_frame_image` |
| `lastFrame` | Optional, **requires firstFrame** | `last_frame_image` |
| `refImages` / `refVideos` / `refAudios` | **No** | Rejected |
| `subject_reference` | **When model is S2V-01** | `firstFrame` → `subject_reference[].image[]` (no lastFrame) |

`firstFrame` / `lastFrame` must be project **image** asset ids. External URLs rejected — import first.

## Modes

| Params | Mode |
| --- | --- |
| `prompt` only | Text-to-video |
| `prompt` + `firstFrame` | Image-to-video |
| `prompt` + `firstFrame` + `lastFrame` | First→last frame transition |

Not available: multi-shot storyboard, multi-ref, subject-reference face lock.
For those → `seedance2` / `kling` when configured.

## When to choose Hailuo

- User named **MiniMax / 海螺 / Hailuo**
- Short **single** clip (6s or 10s), T2V / I2V / simple first→last morph
- Only MiniMax video key is on

Do **not** pick hailuo for multi-shot customize, multi-ref, or non-6/10 durations.

## Tool shape

```ts
// Text-to-video
submit_video({
  model: "hailuo",
  prompt: "…",                 // ≤2000 chars; optional [Push in] camera commands
  durationSeconds: 6,          // or 10 with 720p
  resolution: "720p",          // 1080p → duration 6 only
  name: "Descriptive pool name",
});

// Image-to-video
submit_video({
  model: "hailuo",
  firstFrame: "imageAssetId",
  prompt: "The subject begins to move. [Push in]",
  durationSeconds: 6,
  resolution: "1080p",
  name: "Still · comes alive",
});

// First + last frame
submit_video({
  model: "hailuo",
  firstFrame: "startImageId",
  lastFrame: "endImageId",
  prompt: "Smooth morph between the two frames; continuous camera.",
  durationSeconds: 6,
  name: "Frame morph A→B",
});
```

Then `track_progress({ action: "wait", target: "generation", jobIds: "<jobId>" })`.
Pool-first; place with `edit_item` when the user wants timeline placement.

**Do not pass** `ratio`, `refImages`, `refVideos`, `refAudios`, `shotType`, or `multiPrompts`.

## Prompt writing

### Structure for a 6–10s beat

One clear action: **Subject + Action + Scene + Camera + Style**. CN/EN OK; ≤2000 chars.

### Camera commands (official `[command]` syntax)

| Group | Commands |
| --- | --- |
| Truck | `[Truck left]`, `[Truck right]` |
| Pan | `[Pan left]`, `[Pan right]` |
| Push/pull | `[Push in]`, `[Pull out]` |
| Pedestal | `[Pedestal up]`, `[Pedestal down]` |
| Tilt | `[Tilt up]`, `[Tilt down]` |
| Zoom | `[Zoom in]`, `[Zoom out]` |
| Other | `[Shake]`, `[Tracking shot]`, `[Static shot]` |

Combine ≤3 in one bracket: `[Pan left,Pedestal up]`. Sequence with prose: `…[Push in], then…[Pull out]`.

### I2V / first–last tips

- With `firstFrame` only: describe how the **still evolves**, not a conflicting new subject.
- With `lastFrame`: describe the transition; both stills should be same aspect family when possible.

### Longer stories

Multiple sequential hailuo jobs, or Seedance/Kling multi-shot. One job at a time unless the user asked for parallel clips.

## Subject-reference (S2V-01)

When Settings `MINIMAX_VIDEO_MODEL` is **`S2V-01`** (or any model name matching `/s2v/i`):

- **Required:** `firstFrame` = subject/face still  
- **Forbidden:** `lastFrame`  
- Body uses official `subject_reference: [{ type: "character", image: [...] }]` instead of first/last frame fields  
- Keep prompt under 2000 chars; describe action/scene around that subject  

Default Hailuo models (`MiniMax-Hailuo-02` / `2.3` / `2.3-Fast`) still use first/last frame, **not** subject_reference.

## Optimizer knobs

```ts
submit_video({
  model: "hailuo",
  prompt: "Exact brand shot. [Static shot] No style rewrite.",
  durationSeconds: 6,
  promptOptimizer: false, // more literal
  name: "Literal brand",
});

submit_video({
  model: "hailuo",
  prompt: "Quick draft street walk",
  durationSeconds: 6,
  fastPretreatment: true, // only with optimizer on (default)
  name: "Draft walk",
});
```

## Not wired

| Feature | Status |
| --- | --- |
| Tool enums `512P` / explicit `768P` | Tool uses `720p`/`1080p` only; 720p→API 768P |
| Callback webhooks | We poll |
| Multi-shot API | Use Kling |

## Errors

| Message / pattern | Fix |
| --- | --- |
| `hailuo durationSeconds must be 6 or 10` | Use 6 or 10 |
| `hailuo 1080p only supports durationSeconds 6` | 6s or switch to 720p for 10s |
| `lastFrame requires firstFrame` | Supply both |
| `hailuo does not support refImages/refVideos/refAudios` | Drop multi-ref; use frames only |
| `mode and multi-shot parameters are supported by kling only` | Remove Kling-only fields |
| `MiniMax is not configured` | Set `MINIMAX_API_KEY` |
| Sensitive content / Fail / timeout | Rewrite prompt or stills; no thrice-identical retry |

## Checklist

1. MiniMax video on; `model: "hailuo"`.
2. Duration 6 or 10; if `1080p`, must be 6.
3. lastFrame only with firstFrame; no multi-ref / multi-shot / ratio.
4. Prompt ≤2000; one beat; optional `[camera]` commands.
5. Descriptive `name`; submit once; `track_progress`; pool-first placement.

## Comparison

| Need | Prefer |
| --- | --- |
| Fast short T2V / I2V / first–last on MiniMax | **hailuo** |
| Multi-ref, edit/extend, audio refs | **seedance2** |
| Formal multi-shot with per-shot durations | **kling** customize |
