# Seedance 2.0 (`seedance2`)

Read this before `submit_video({ model: "seedance2", … })`.

Grounded in OpenChatCut’s video adapter (`server/plugins/video.ts` → Seedance
`/contents/generations/tasks`). Capability claims outside what we wire are
**not** to be promised. Official prompt patterns (subject/motion/camera,
multimodal `@` refs, edit/extend/bridge) are adapted here to our tool shape.

## Capabilities (as wired)

| Dimension | Value |
| --- | --- |
| Duration | **2–15** seconds integer (default **5**) |
| Resolution | **`480p`** / **`720p`** (default) / **`1080p`** / **`4k`** — API `resolution` (4k needs full Seedance 2.0; Fast/Mini may reject) |
| Aspect ratio | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`, `adaptive` |
| Audio out | `generateAudio` → `generate_audio` (official default true) |
| Provider controls | `seed`, `cameraFixed`, `watermark`, `returnLastFrame`, `executionExpiresAfter` (3600–259200), `priority` (0–9) |
| Prompt | Required; keep focused (CN ≈ ≤500 chars, EN ≈ ≤1000 words useful bound) |
| Multi-shot API | **None** — multi-shot is **prompt structure only** (not Kling `shotType` / `multiPrompts`) |

When `firstFrame` or `lastFrame` is set, the server **forces `ratio: "adaptive"`**
(follows the frame image). Explicit `ratio` is ignored in that case.

## Input channels → server roles

| Tool param | Server role | Prompt token | Limits |
| --- | --- | --- | --- |
| `firstFrame` | `first_frame` | `@ImageN` (first image in payload order) | 1 image |
| `lastFrame` | `last_frame` | next `@ImageN` | requires `firstFrame` |
| `refImages[]` | `reference_image` | `@ImageN` in array order after frames | ≤ **9** |
| `refVideos[]` | `reference_video` | `@Video1`… | ≤ **3** |
| `refAudios[]` | `reference_audio` | `@Audio1`… | ≤ **3**; needs ≥1 visual (frame or image/video ref) |

All slots are **project asset refs**. External URLs are rejected. Reference videos are uploaded to configured R2 and sent as temporary HTTPS URLs because the official API does not accept video data URLs.

**Ordinal rule:** images are numbered in **payload order**: `firstFrame` → `lastFrame` → `refImages[0]`… Videos and audios number only within their own arrays. Always name the role in prose after the token: `@Image1 (the red coat woman)`, not bare `@Image1 walks…` (number segmentation errors).

## Modes (inferred — no `mode` param)

| Params | Mode | Use when |
| --- | --- | --- |
| `prompt` only | text-to-video | Pure description, no visuals |
| `firstFrame` + prompt | image-to-video | Animate a known start frame |
| `firstFrame` + `lastFrame` + prompt | first→last transition | Strict start/end stills |
| any `refImages` / `refVideos` / `refAudios` (± `firstFrame`) | reference-guided | Style/subject/motion/audio anchors, edit, extend, bridge |

**Hard exclusion:** `lastFrame` **cannot** combine with `refImages` / `refVideos` / `refAudios` (server rejects). Choose either strict first–last transition **or** reference-guided work.

Kling-only fields (`shotType`, `multiPrompts`, `mode: std|pro`) are rejected for seedance2.

## Mode recipes

### A. Text-to-video

```ts
submit_video({
  model: "seedance2",
  prompt: "…", // 8-element structure preferred
  durationSeconds: 8,
  ratio: "9:16",
  name: "Descriptive pool name",
});
```

### B. Image-to-video (first frame)

```ts
submit_video({
  model: "seedance2",
  firstFrame: "assetId",
  prompt: "The scene comes alive: soft wind, slow push-in, …",
  durationSeconds: 6,
  name: "Living still · push-in",
});
// ratio becomes adaptive server-side
```

### C. First + last frame

```ts
submit_video({
  model: "seedance2",
  firstFrame: "startId",
  lastFrame: "endId",
  prompt: "Smooth morph between the two frames; continuous camera; no jump cuts.",
  durationSeconds: 5,
  name: "Frame morph A→B",
});
// no refImages / refVideos / refAudios
```

### D. Reference-guided (subject / style / multi-image)

Pass anchors as `refImages` (and optional `firstFrame`). **Tell the prompt what each image is for.**

| Intent | Prompt pattern |
| --- | --- |
| Multi-angle subject | `Reference @Image1 @Image2 @Image3 for the product/character appearance; …` |
| Subject + scene | `@Image1 (character) in @Image2 (cafe interior) …` |
| Outfit + person | `@Image1 person wearing outfit from @Image2 …` |
| Storyboard panels | `Follow storyboard order in @Image1; each panel in sequence …` |
| Logo / on-screen brand | `… then @Image2 logo settles lower-right …` |

Prefer **appearance** language (“black short hair, silver earring”) over proper names the model cannot see.

### E. Video reference (motion / camera / VFX)

| Intent | Prompt pattern |
| --- | --- |
| Action / choreography | `Reference @Video1 for the fight/dance motion; characters from @Image1 …` |
| Camera only | `Follow @Video1's camera path and transitions; subject from @Image1 …` |
| Effects | `Reference @Video1 particle/wing effect on @Image1 …` |
| Rhythm / cuts | `Cut rhythm matches @Video1; subjects from @Image1–@ImageN …` |

Be explicit: **which attribute** of `@VideoN` (motion vs camera vs grade vs pacing).

### F. Edit / extend / bridge (still `refVideos` + prompt)

These create a **new** pool asset; they do not mutate the source timeline item.

| Use case | Prompt shape (prefer direct verbs) | Params |
| --- | --- | --- |
| **Edit** | `Replace the scarf in @Video1 with a red one; keep camera and timing.` | `refVideos: [source]` ± `refImages` for replacements |
| **Extend after** | `Continue after @Video1: …` / `Generate content after @Video1: …` | `refVideos: [source]`; `durationSeconds` = length of the **new** generated segment |
| **Extend before** | `Generate content before @Video1: …` / lead-in into the existing clip | same |
| **Bridge / track** | `@Video1, [transition], then @Video2, [transition], then @Video3` | up to **3** videos; total ref video time ideally ≤ **15s** |

**Edit vs pure reference:** for edit/extend, address `@Video1` as the **source to change/continue**. Avoid “reference @Video1 for style” wording when you actually want an edit — that steers the model into generic R2V.

When iterating a failed shot, prefer **edit** of the best prior take over full T2V restarts (keeps what already works).

### G. Audio reference

```ts
submit_video({
  model: "seedance2",
  refImages: ["subjectId"],
  refAudios: ["bedId"],
  prompt: "@Image1 character walks a rainy street; timing and mood follow @Audio1.",
  durationSeconds: 8,
  name: "Rain walk · audio-led",
});
```

Audio alone is invalid — always pair with a visual channel.

## Prompt writing

### Core formula

**Subject + Action/Motion + Scene + Lighting/Color + Camera + Style + Quality + Negatives**

Fill only what matters; omit empty slots. For multi-shot, write a **timeline storyboard** (who / where / action / camera per beat).

### Three multi-shot styles (single clip, 4–15s)

1. **Short ideation** — one paragraph, one or two beats (exploration).
2. **Descriptive package** — aesthetic + story + characters + environment + action + production notes + negatives (balanced control).
3. **Granular timestamps** — `Shot 1 (0–2s): … Shot 2 (2–5s): …` matching `durationSeconds` (max control).

Longer durations (10–15s) tolerate more sub-shots; still **one camera move per sub-shot**.

**Continuous single take** — when the user wants unbroken motion, say so explicitly: `one continuous take, no hard cuts` and describe a single evolving path instead of numbered shots.

**Timestamp tips**

- Sum of shot windows should equal `durationSeconds`.
- Put intentional transitions at boundaries (“hard cut to CU”, “whip pan into …”).
- Quality/negative tail once at the end, not per shot.

**Example (8s, 9:16, 4 sub-shots + image anchor):**

```
8s, 9:16, cinematic.
Shot 1 (0–2s): Full shot, @Image1 woman walks onto red carpet, soft top-light, slow dolly in.
Shot 2 (2–4s): Medium shot, she turns to camera, holds perfume bottle, key light camera-left.
Shot 3 (4–6s): Close-up on the bottle, gentle rotation, shallow DOF.
Shot 4 (6–8s): Medium shot, she smiles, dress hem moves in light wind.
4K sharp details, face stable, no mutation, no duplicated limbs, hands anatomically correct.
```

### @ mention hygiene

| Do | Don't |
| --- | --- |
| `@Image1 (dark-haired woman) enters @Image2 (loft)` | `make her look like the reference` |
| `Reference @Video1 for camera only` | stack push-in + orbit in one sub-shot |
| `@Image1 on LEFT, @Image2 on RIGHT, fixed camera` | rely on names without appearance words |

After `@ImageN` / `@VideoN` / `@AudioN`, always a **noun or parenthetical** before verbs.

### Camera language (model-friendly)

| Category | Terms |
| --- | --- |
| Shot size | Close-up, MCU, Medium, Full, Long, Extreme long |
| Angle | Eye-level, Low, High, OTS, Top-down |
| Move | Push-in, Pull-out, Pan, Tilt, Dolly/Track, Orbit, Handheld |
| Lens / FX | Shallow DOF, Slow-mo, Time-lapse, Hitchcock zoom |

### On-screen text & dialogue (prompt-only)

Native audio is always generated. You can request:

- **Titles / slogans:** content + timing + position + style  
  (`text "…" appears center after 2s, bold white`)
- **Subtitles:** bottom captions synced to spoken lines
- **Speech bubbles:** character says "…"; bubble near speaker
- **Spoken lines:** quote dialogue in the prompt for lip-sync-ish delivery

Prefer common characters; avoid rare glyphs/special symbols for burned-in text.

### Quality & stability tail

For faces / characters, append by default unless the user wants lo-fi:

> `sharp details, character face stable, no mutation, no clipping, no duplicated limbs, hands anatomically correct`

## Cross-clip consistency (multiple jobs)

Seedance calls are **stateless**. For recurring identity across separate `submit_video` jobs:

1. Pin a static anchor: `refImages: [characterOrProduct]`.
2. After shot N is approved, also pass it as `refVideos: [shotNAssetId]` on shot N+1.
3. Wait with `track_progress` (`action=wait`) before dependent jobs — never parallelize dependent continuity.
4. After **two** failed text-only retries on identity, stop tweaking prose → change/add anchors or use **edit** mode on the best take.

Multi-character: one anchor image per character; every prompt names the **active** character + attributes and **negates** the others; same-frame → left/right + outfit colors + prefer fixed camera.

## When to use Seedance vs Kling vs Hailuo

| Need | Prefer |
| --- | --- |
| Multimodal refs (video/audio), edit/extend/bridge | **seedance2** |
| Structured multi-shot with per-shot durations (`multiPrompts`) | **kling** `shotType=customize` |
| Quick auto multi-shot from one paragraph | **kling** `shotType=intelligence` |
| Simple 6s/10s T2V or single-image I2V only | **hailuo** |

## Content review

- Real human faces (incl. photoreal generated) generally OK as refs.
- Celebrity / IP / branded mascot likenesses often blocked — surface the error; ask for another ref; do not blind-retry the same assets.

## Errors (server / provider)

| Message / pattern | Fix |
| --- | --- |
| `seedance2 resolution must be 480p, 720p, 1080p, or 4k` | Use one of those four |
| `seedance2 lastFrame mode cannot be combined with references` | Drop refs **or** drop `lastFrame` |
| `seedance2 reference limit exceeded` | ≤9 images, ≤3 videos, ≤3 audios |
| `seedance2 audio references require a visual reference` | Add firstFrame or ref image/video |
| `lastFrame requires firstFrame` | Supply both |
| `durationSeconds must be between 2 and 15` | Clamp duration |
| `does not support ratio …` | Use allowed ratio list |
| content-review / policy failure | New refs; do not retry same IP face |
| timeout / provider failed | Report; adjust prompt or simplify refs; avoid thrice-identical payload |

## Tool checklist before submit

1. `model: "seedance2"` and Seedance key is on (capabilities).
2. `name` is descriptive for the media pool.
3. Param combo matches the intended mode (see exclusion rules).
4. Every media slot is a project asset id; prompt `@` ordinals match payload order.
5. `durationSeconds` integer 2–15; multi-shot timestamps sum to it.
6. `resolution` is `480p` (draft), `720p` (default), `1080p`, or `4k` (final delivery; heavier).
7. No Kling-only fields.
8. Briefly tell the user model + duration + mode before calling.

## Full multimodal example

```ts
submit_video({
  model: "seedance2",
  prompt: [
    "9:16, 10s, cinematic product film.",
    "Shot 1 (0–3s): @Image1 bottle on marble, slow orbit, soft key from left.",
    "Shot 2 (3–7s): hand lifts bottle; motion energy follows @Video1 camera push.",
    "Shot 3 (7–10s): hero CU, label sharp; mood follows @Audio1.",
    "sharp details, no warping logo, stable reflections.",
  ].join(" "),
  firstFrame: "heroStillId",       // @Image1
  refImages: ["labelDetailId"],    // @Image2
  refVideos: ["orbitRefId"],       // @Video1
  refAudios: ["bedId"],            // @Audio1
  durationSeconds: 10,
  name: "Bottle hero · 10s multi-beat",
});
```

Then:

```ts
track_progress({ action: "wait", target: "generation", jobIds: "<jobId>" });
```

Asset lands in the **media pool only**. Place with `edit_item` when the user wants it on the timeline.
