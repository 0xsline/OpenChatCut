# Kling

Read this document before generating videos with `model: "kling"` on `submit_video`.

## Model & task

We expose **Kling V3 Omni** only, always submitted as the `omni-video` task internally. Don't surface model variants (V3 / O3 / O1 / 2.6 / 2.5 Turbo) to the user — refer to it as "Kling".

## Capabilities

- Duration: 3–15 seconds (integer only, default 5s)
- Aspect ratio: `16:9`, `9:16`, `1:1`
- Mode: `std` (default) or `pro` (higher quality, slower)
- Prompt: up to 2500 characters
- Input images: 300×300 min, 10MB max, JPG/JPEG/PNG (no data URLs)
- Native audio generation (always on)
- Multi-shot storyboard: 2–6 shots in one job, identity preserved across shots

## Input Channels

| Param                 | Meaning                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `firstFrame: string`  | Start frame                                                                                       |
| `lastFrame: string`   | End frame (omni-video requires a first frame whenever an end frame is given)                      |
| `refImages: string[]` | Style/subject references (combined ≤7 with first/last frames; referenced as `@Image1`, `@Image2`) |

Image inputs take a project **asset reference**. Prefer a UUID or short prefix from `read_project`; `asset://<id>` and same-project asset URLs returned by `read_project` are also accepted. External URLs and base64 are rejected at the tool boundary — import them into the project first.

`refVideos` and `refAudios` are accepted by the tool schema for symmetry with Seedance, but **Kling currently ignores them** — see §Limitations.

## Kling-Specific Params

| Param                                         | Values                      | Default                   |
| --------------------------------------------- | --------------------------- | ------------------------- |
| `mode: "std" \| "pro"`                        | `std`, `pro`                | `std`                     |
| `shotType: "customize" \| "intelligence"`     | `customize`, `intelligence` | required for multi-shot   |
| `multiPrompts: [{ prompt, duration, index }]` | array of shots              | required when `customize` |

## Prompt References

When reference assets are passed as params, refer to them in the prompt by type and ordinal:

- `@Image1`, `@Image2`, … — reference images in order of appearance (`firstFrame` first if present, then `refImages` in array order)

Example: `"@Image1 character walks into the scene, maintaining the style of @Image2"`

## Multi-shot storyboard

Submit 2–6 shots in a single job; Kling preserves identity across them without explicit anchors.

**`shotType: "intelligence"`** — pass a single top-level `prompt` describing the whole sequence; the model auto-decomposes. Use when the user wants quick coverage and doesn't need per-shot duration control.

**`shotType: "customize"`** — omit top-level `prompt`; pass `multiPrompts` instead. Each shot is a self-contained scene. Backend rules:

- 2–6 shots
- Each `prompt` ≤ 512 characters
- Each `duration` is an integer ≥ 1
- Sum of `duration` must equal `durationSeconds` (total job duration)
- `index` is 1-based and consecutive: shot 1 → `index: 1`, shot 2 → `index: 2`, … (Kling rejects index starting at 0 or with gaps)

Example:

```ts
submit_video({
  model: "kling",
  shotType: "customize",
  durationSeconds: 12,
  ratio: "16:9",
  multiPrompts: [
    {
      index: 1,
      duration: 4,
      prompt:
        "[Shot 1] MCU. Slow dolly in. Key from camera-left, 5500K. ... Motion settles as ...",
    },
    {
      index: 2,
      duration: 4,
      prompt: "[Shot 2] WS. Static. ... Motion settles as ...",
    },
    {
      index: 3,
      duration: 4,
      prompt: "[Shot 3] CU. Pan right. ... Motion settles as ...",
    },
  ],
  name: "Cafe scene storyboard",
});
```

When using `customize`, write each shot like a standalone shot using the rules below.

## Prompt structure (essential rules)

Kling is a **technical-script** model. It does not auto-decompose scenes or auto-infer camera movements. Every shot needs explicit structure. The eight rules stack — each one fixes a specific failure mode.

### 1. Motion endpoint — required, every shot

End every shot with `Motion settles as <specific ending state>`. Without it, generations frequently stall at 99% or cut off abruptly. Applies to single-shot prompts, image-to-video, and every entry in a `customize` storyboard.

```
✗ A young woman walks down a rainy alley, neon reflections in puddles.
✓ A young woman walks down a rainy alley, neon reflections in puddles.
  Motion settles as she pauses under a red lantern, turns her face slightly toward camera.
```

### 2. Hollywood-standard shot sizes (English)

Open every shot with the English term + abbreviation. Vague Chinese terms (近景 / 中景) and unscoped prompts both drop recognition.

| Shot size        | Abbr | Use for                     |
| ---------------- | ---- | --------------------------- |
| Extreme close-up | ECU  | Eye, finger, single tear    |
| Close-up         | CU   | Face / single object        |
| Medium close-up  | MCU  | Head + shoulders, dialogue  |
| Medium shot      | MS   | Waist up                    |
| Medium long shot | MLS  | Full body, mid-distance     |
| Wide shot        | WS   | Full environment, establish |

### 3. Declare camera movement explicitly

Every shot needs ≥1 movement (`static` is valid — write it explicitly; never omit). Combine at most 2 per shot; 3+ degrades quality.

| Category    | Movements                                             |
| ----------- | ----------------------------------------------------- |
| Static      | static                                                |
| Push / Pull | dolly in, dolly out, pull back                        |
| Pan / Tilt  | pan left, pan right, tilt up, tilt down               |
| Tracking    | lateral tracking left/right, following shot           |
| Orbit       | slow 180 orbit (avoid for fast action — disorienting) |

Speed modifiers: `very slow / slow / medium / fast / whip`. Combine: `slow dolly in, then static`.

By drama type: emotional → `static` or `very slow dolly in`; action → `lateral tracking`; reveal → `slow pan` or `slow pull back`; product → `slow 180 orbit`.

### 4. Lighting triplet

"Warm lighting" alone is too vague. Spell out all three:

- **Direction**: e.g., `key from camera-left window`
- **Color temperature**: a specific Kelvin value (2700K–7500K)
- **Color tone**: e.g., `warm amber`, `teal-and-amber`, `cool blue`, `neutral`

Skipping any of the three causes face drift across frames and inconsistent shadows.

### 5. Sequential action — `first / then / finally`

For multi-step actions inside one shot, use the explicit sequencing structure. Flat description ("he walks in and turns around") confuses temporal reasoning.

```
First, she reads the open book calmly.
Then, she looks up suddenly as if hearing something, eyes widening.
Finally, she closes the book and stands up.
Motion settles as she stands fully upright, hand resting on the closed book.
```

### 6. Time slicing for shots ≥ 5s

For multi-beat shots, specify how many seconds each beat takes:

```
[Shot 2 / MCU / 6s]
  - 0–2s: Grandmother wraps the scarf around granddaughter's neck
  - 2–4s: Her fingers smooth the wool at the throat
  - 4–6s: Granddaughter closes her eyes, leans into grandmother's hand
Motion settles as grandmother's hand rests on the girl's cheek.
```

### 7. Emotions → physical manifestations (≥3)

Replace abstract emotion words with concrete physical signals. One signal feels mechanical; combine ≥3.

| Emotion | Combine 3+ of                                                                        |
| ------- | ------------------------------------------------------------------------------------ |
| Sad     | eyes glisten, lower lip trembles, breath becomes shallow, fingers curl loosely       |
| Scared  | pupils contract, breath catches in throat, cold sweat on forehead, hands tremble     |
| Happy   | eye-corner crinkles, mouth corners lift asymmetrically, shoulders relax, soft exhale |
| Angry   | jaw clenches, nostrils flare, knuckles whiten, breath quickens                       |

```
✗ Marcus looks scared.
✓ Marcus's pupils contract as his eyes widen, breath catches in his throat,
  a thin film of cold sweat forms on his forehead, his left hand trembles at his side.
```

### 8. Complexity ceiling — ≤7 elements per shot

Count elements: each character ≈ 1, each independent physical event ≈ 1, each continuous action ≈ 1, each background environment ≈ 1, secondary dynamics (wind/fog/falling leaves) ≈ 0.5. Over the limit → split into two shots.

## Multi-character anchors

When two characters share the frame, the model leaks attributes (A's clothing on B). Use explicit attribution + explicit negation, plus position words and outfit colors:

```
The character on the LEFT is @character_A — grey-blue tactical jacket, short beard.
NOT red cape, NOT braided hair.
The character on the RIGHT is @character_B — red cape with gold trim, long braided hair.
NOT grey-blue jacket, NOT short beard.
Camera: fixed, medium shot, both characters clearly separated.
```

## Real-person photo references

When passing a real-person photo as a reference, results are best when the photo is frontal (0–15° rotation), ≥1024×1024, evenly lit, neutral expression, no occlusion.

## Drama / emotional shot principles

When the request involves character performance or fine emotional control, lean on these (operations research, distilled):

- **No literary words** — replace "sad / shocking / eerie" with physical description (rule §7).
- **Vectorize action** — give each action a starting point, trajectory, and force/frequency, not just a verb.
- **Bio-consistency** — force ≥3 micro-expressions per emotion (throat swallow, jaw tension, blink rate).
- **Frame anchoring** — every shot must declare shot size + camera + lighting (rules §2/§3/§4).
- **Motion endpoint mandatory** — no exceptions (rule §1).
- **Bilingual division** — narrative in any language; technical directives (`Camera`, `Lighting`, `Motion settles`, `[Speaker:]`, `@reference`) in English.

## Limitations (don't promise these)

- **Voice Binding / voice cloning**: Kling O3 Omni only — not on V3 Omni. Don't offer.
- **Motion Brush**: a Kling Web UI feature, not in the public API.
- **Motion Control via reference video**: not currently forwarded by our integration; `refVideos` is accepted by the tool schema but has no effect on Kling submissions today.
- **`negative_prompt` field**: omni-video doesn't accept it. Bake avoidance directly into the `prompt` text, e.g. `… Avoid: blurry hands, extra fingers.`
- **Element library binding**: we don't yet upload to Kling's element library, so there's no parameter for it today.

## Failure handling

- 99% stall / abrupt cut-off → almost always a missing motion endpoint (rule §1).
- Face drift across separate jobs → reuse the same `refImages` entry on every shot; wait for the previous shot to complete (`track_progress` with `action=wait`) and use its frozen frame as the next shot's `firstFrame`. For 2–6 shots in one job, prefer multi-shot storyboard instead.
- Identity bleed between two on-screen characters → use the multi-character anchors block above.
- After **two** text-only retries on the same drift → stop adjusting text. Add or switch the reference image.
