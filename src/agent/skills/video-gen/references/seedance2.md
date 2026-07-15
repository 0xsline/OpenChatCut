# Seedance 2.0

Read this document before generating videos with `model: "seedance2"` (the default for `submit_video`).

## Capabilities

- Duration: 4–15 seconds (default 5s) via `durationSeconds`
- Audio: always on (music, narration, ambient). There is no audio toggle parameter for Seedance 2.0.
- Aspect ratio: `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, or `adaptive` via `ratio`. `adaptive` auto-follows the input image's ratio — the backend auto-rewrites `ratio` to `adaptive` when `firstFrame` or `lastFrame` is set.
- Resolution: `720p` (only resolution currently wired; do not pass other values to `resolution`)

## Input Channels

Two categories:

- **Frames** appear at specific positions in the generated clip (first / last frame).
- **References** shape the generation (style, subject, motion, or audio) but are not placed as fixed frames in the output. How strictly a reference is followed depends on how you describe it in the prompt — from "use exactly this style" to "take inspiration from this".

| Category      | Param                 | Meaning                                                                                                                                  |
| ------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Frame**     | `firstFrame: string`  | The exact first frame of the generated clip                                                                                              |
| **Frame**     | `lastFrame: string`   | The exact last frame; setting this enables first-last-frame transition mode                                                              |
| **Reference** | `refImages: string[]` | Image references — e.g. subject appearance, style, composition. Not placed as specific frames in the output.                             |
| **Reference** | `refVideos: string[]` | Video references — e.g. motion continuity, style, or as the source for edit / extend / bridge. How each is used is driven by the prompt. |
| **Reference** | `refAudios: string[]` | Audio references — e.g. rhythm, melody, ambient tone. Must combine with at least one visual input (frame or image / video reference).    |

Limits: 9 ref images, 3 ref videos, 3 ref audio. Each file ≤50MB (video), ≤30MB (image), ≤15MB (audio).

All frame/reference slots take a project **asset id** (UUID or short prefix from `read_project`), `asset://<id>`, or a same-project asset URL. External URLs are not accepted — pull them into the project first via `download_media` or `submit_image`.

## Modes (inferred from params)

Modes are inferred automatically from which params you pass — there is no separate mode parameter.

| Param combination                                                                                | Mode                        | Notes                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt` only                                                                                    | text-to-video               | No visual input                                                                                                                                                                                                                                                                             |
| `firstFrame` alone                                                                               | image-to-video              | Animate forward from a specific start frame                                                                                                                                                                                                                                                 |
| `firstFrame` + `lastFrame`                                                                       | first-last-frame transition | Strict start → end frames                                                                                                                                                                                                                                                                   |
| any of `refImages` / `refVideos` / `refAudios` (alone or combined, optionally with `firstFrame`) | reference-guided            | Generation guided by one or more references. What each reference _does_ (style guide, subject anchor, motion continuity, editing existing footage, bridging segments, …) is driven by the **prompt**, not by how many refs you pass. See §Editing & Extending for concrete prompt patterns. |

**First-last-frame mode is mutually exclusive with reference inputs.** If `lastFrame` is set, you cannot also pass `refImages`, `refVideos`, or `refAudios` — the request will be rejected by the backend. Choose one: either strict frame transition, or reference-guided generation.

## Content Review

Seedance applies content review on inputs. Two cases worth knowing:

- **Real human faces** (including AI-generated photorealistic faces) — supported. Pass real-person photos directly via `refImages`, `firstFrame`, or `lastFrame`.
- **Copyright / IP-protected likenesses** — recognizable celebrities, public figures, well-known fictional characters, branded mascots — remain blocked. If submission fails and the input is a recognizable IP face, surface the failure and ask for a different reference.

_Edge case: videos previously generated by Seedance 2.0 under the same account can be reused as edit / extend inputs without re-review._

## Seedance Error Handling

- If a submission fails with a content-review error, surface the failure and ask the user for a different reference. Don't retry with the same input.

## Prompt Writing

Seedance 2.0 has strong intent comprehension. Structure prompts around eight elements:

**Subject** + **Action** + **Scene** + **Lighting / Color** + **Camera** + **Style** + **Quality** + **Negative Constraints**

- **Subject** — who / what is the main subject (appearance, outfit, defining features).
- **Action** — what they are doing, including micro-expressions for talking or emotional shots.
- **Scene** — where, when, environmental details.
- **Lighting / Color** — atmosphere, color grading, contrast, mood.
- **Camera** — shot size, angle, movement (see **Camera language** below).
- **Style** — visual style or genre (cinematic, anime, documentary, film-grain, …).
- **Quality** — resolution and detail cues, e.g. "4K, sharp details, film-grade quality".
- **Negative Constraints** — what to avoid (see **Quality & stability tails** below).

Keep prompts concise: Chinese ≤500 characters, English ≤1000 words. Overly long prompts dilute focus — the model may drop details when information is too dense.

### Prompt References

When reference assets are passed as params, the prompt text refers to them by type and ordinal number. The Seedance API assigns numbers **by order of appearance in the request**, without distinguishing frame vs reference.

- `@Image1` / `@图片1` — first image input. `firstFrame` counts as Image1 if present; otherwise `refImages[0]` is Image1. Subsequent images follow array order (`@Image2`, `@Image3`, …).
- `@Video1` / `@视频1` — `refVideos[0]`; `@Video2` is `refVideos[1]`; etc.
- `@Audio1` / `@音频1` — `refAudios[0]`; same pattern.

Example: `refImages: ["A", "B"], refVideos: ["C"]` → in the prompt, `@Image1` = A, `@Image2` = B, `@Video1` = C.

In prompts, always refer to passed inputs by explicit numbered references (`@Image1`, `@Video1`, `@Audio1`) rather than vague descriptions.

**Do**: `"@Image1 (the dark-haired woman) walks into the scene from @Image2 (the living room)"` — clear, unambiguous.
**Don't**: `"make the character look like that reference image"` — vague; the model may pick the wrong input.

**After `@ImageN` / `@VideoN`, always follow with a noun or clarifier** — `@Image1 character walks...`, `@Image1 (the black car) drifts...`, `@视频1 的镜头继续`. Do NOT directly attach a verb, position word, or another number (e.g. `@Image2 stands...`, `@图2位于...`, `@Image1 2 seconds later`) — the model may mis-segment the number and produce wrong counts.

### Quality & Stability Tails

For character-focused or face-visible clips, **always append quality and stability cues** as a tail, for example:

> "4K, sharp details" + "character face stable, no mutation, no clipping, no duplicated limbs, hands and fingers anatomically correct"

These failure-prevention tails materially improve hit rate. Include them by default unless the user explicitly asks for a raw / lo-fi / experimental look.

### Camera Language

Seedance 2.0 understands these terms well:

| Category  | Terms                                                          |
| --------- | -------------------------------------------------------------- |
| Shot size | Close-up, Medium Shot, Full Shot, Long Shot, Extreme Long Shot |
| Angle     | Low Angle, High Angle, Eye-level, Over-the-shoulder            |
| Movement  | Push-in, Pull-out, Pan, Dolly/Track, Following Shot, Orbit     |
| Effects   | Slow Motion, Time-lapse, Shallow Depth of Field, Handheld Feel |

**Single camera movement per sub-shot.** Avoid stacking conflicting movements in one sub-shot (e.g. push-in + pan-left, or dolly + orbit). When a beat needs a different camera move, use another sub-shot — prefer chaining sub-shots inside the same clip (see §Multi-shot within a single clip below); split into multiple clips only when the total duration exceeds 15s or the boundary is a hard scene break.

## Multi-shot within a single clip

A single 4–15s Seedance generation does not have to carry only one camera setup. With clear sub-shot structure in the prompt (`Shot 1: ... → Shot 2: ...`, or timestamp slicing `0–2s ... | 2–4s ...`), the model strings several sub-shots into a continuous beat inside one clip.

**Characteristic.** A single generation is a single inference pass — subject identity, lighting, color, and style are physically consistent across the whole clip as a natural byproduct of one diffusion process. When the same beats are split into multiple separate clips, each clip is an independent inference; subject identity, lighting, and color tend to drift across clips and need `--ref-image` / `--ref-video` to keep them aligned.

**When to fall back to multiple clips.**

- Total duration exceeds 15s.
- A sub-shot boundary is a hard cut to a completely unrelated scene or subject — anchor-based cross-clip consistency fits that better than a single-clip narrative.

A single sub-shot still follows the one-camera-movement rule. Multiple camera movements get multiple sub-shots, not stacked into one.

**Prompt structure.**

- Write each sub-shot in the 8-element form, but only fill in what changes from the previous sub-shot — let the model carry forward the rest.
- Put transitions at sub-shot boundaries when intentional ("camera cuts to a CU as she turns").
- The Quality & Negative tail covers the whole prompt; do not repeat it per sub-shot.

**Example (8s vertical, 4 sub-shots):**

```
8s, 9:16, cinematic.
Shot 1 (0–2s): Full shot, she walks onto the red carpet, soft top-light, slow forward dolly.
Shot 2 (2–4s): Medium shot, she turns to camera, holds @Image1 perfume bottle, key light from camera-left.
Shot 3 (4–6s): Close-up on @Image1, gentle rotation, shallow depth of field.
Shot 4 (6–8s): Medium shot, she smiles back at camera, dress hem flutters.
4K sharp details, character face stable, no mutation, no clipping, hands anatomically correct.
```

## Editing & Extending

These are **prompt-driven use cases** of the `reference-guided` mode — they produce a **new generated video clip** based on a source clip, not timeline edits. The output is a fresh asset; the original is not modified.

All three patterns pass the source clip(s) via `refVideos`; the use case is determined by what the prompt asks for. The source video must be a completed generation (use its `assetId`).

| Use case   | What the prompt asks                                                           | Example prompt                                        |
| ---------- | ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Edit**   | Replace or adjust elements while keeping the rest                              | "Replace the scarf in @Video1 with a red one"         |
| **Extend** | Continue forward, or prepend earlier footage                                   | "Continue from @Video1, the character opens the door" |
| **Bridge** | Fill a gap between 2–3 segments (pass each as a separate entry in `refVideos`) | "Smooth transition from @Video1 to @Video2"           |

These are typical patterns, not an exhaustive list — `refVideos` is a flexible reference channel and the prompt can express other intents too (style continuation, motion-only carry-over, etc.).

When the user is unhappy with a result, prefer editing over regenerating from scratch — cheaper, and preserves what already works.

## Seedance-Specific Consistency Implementation

Seedance 2.0 is stateless — each call is independent. For cross-model anchor _principles_ (when to use, how to source, multi-character, escalation), see §Visual consistency across shots in SKILL.md. The Seedance-specific _implementation_ details below complement those principles.

### How to pass an anchor (Seedance params)

- `refImages: [<imageAssetId>]` — pin a static image anchor (character, style, composition).
- `refVideos: [<videoAssetId>]` — pin a video anchor (motion continuity, edit/extend/bridge source).

### Carry approved shots forward when consistency is explicit

In a multi-shot sequence with a clearly stated consistency need (same character, scene, or style across shots), after the first shot is approved, pass the most recently approved shot in `refVideos` for subsequent shots — **in addition to** the static image anchor. The combination `refImages: [<character>] + refVideos: [<previous-approved-shot>]` anchors both identity (from the image) and motion / style continuity (from the video), and is stronger than either one alone. If the user's consistency intent is not clear — e.g. the next shot is in a very different setting and it's not obvious what should stay the same — **ask before generating**. Don't assume.

### When a shot depends on a previous generation

Wait for the previous job to complete (via `track_progress` with `action=wait`) to obtain its `assetId`, then pass that id in `refVideos`. Do not submit dependent shots in parallel.

### Establishing a new anchor — Seedance paths

When no existing asset fits and one must be generated:

- **Generated character / illustration** → `submit_image` to create a reference, then pass its asset id in `refImages`.
- **Real-person photo** → if the user has an existing photo, use it directly in `refImages`. The backend handles content review automatically. If the user wants a generated photorealistic character, use `submit_image` then pass in `refImages` — same flow.

### Multi-character — Seedance param

Pin the correct character's anchor in `refImages`. Do not reuse another character's anchor by accident.

### Escalation — edit mode on Seedance

Reuse the best-looking existing shot in `refVideos` and describe the change in the prompt. This is Seedance's "edit mode" path for breaking a stuck consistency loop.

### Example: two-shot sequence with a character anchor

```ts
// Shot 1 — anchor character appearance with a reference image
submit_video({
  model: "seedance2",
  refImages: ["character-ref-id"],
  prompt:
    "@Image1 black racing car drifts around a rain-soaked corner, left to right. Sparks fly from tires.",
  name: "Chase scene — shot 1 drift",
});

// Wait for shot 1 to finish (call `track_progress` with action="wait", jobIds=[<shot1-jobId>]),
// then read its `outputAssetId` from the returned entry.

// Shot 2 — same character ref + shot 1 as video reference for motion continuity
submit_video({
  model: "seedance2",
  refImages: ["character-ref-id"],
  refVideos: ["<shot1-assetId>"],
  prompt:
    "Same @Image1 black racing car continues speeding. Carry forward the motion style of @Video1. Camera follows from behind.",
  name: "Chase scene — shot 2 follow-through",
});
```
