---
name: video-gen
description: |
  AI video generation via Seedance 2.0, Kling, and MiniMax Hailuo. Use when the user wants to generate a video clip — text-to-video, image-to-video, first/last-frame transitions, reference-guided generation, multi-shot, or generatively editing / extending an existing clip.
user-invocable: true
---

# Video Gen

Submits one video generation job per call and returns a `jobId`. Job management (wait / status) belongs to `track_progress`; this skill does **not** place videos on the timeline automatically.

## When to Use

Any time the user wants to generate a video clip — text-to-video, image-to-video, first-last-frame transition, reference-based generation, multi-shot storyboard, or generatively editing / extending an existing video (producing new generated footage based on a source clip; not timeline trimming).

## Models

| Model | Reference | Strengths |
| --- | --- | --- |
| `seedance2` | [references/seedance2.md](references/seedance2.md) | Default when configured. Multimodal refs, first/last, edit/extend/bridge, 2–15s, 480p/720p/1080p/4k, audio/seed/camera/watermark/last-frame/task controls. |
| `kling` | [references/kling.md](references/kling.md) | Technical camera/performance; Omni multi-shot; images ≤7 (≤4 with one feature `refVideos`); std/pro; 3–15s. |
| `hailuo` | [references/hailuo.md](references/hailuo.md) | MiniMax conch. T2V / I2V / first+last; **6s or 10s**; 512P (Hailuo-02), 720p→768P, 1080P (6s); no multi-ref / multi-shot. |

**IMPORTANT:** Before generating, READ the chosen model's reference for capabilities, input channels, modes, prompt structure, and model-specific behavior. Never invent params the reference forbids.

## Model Selection

Respect **configured vendors** from the capabilities prompt (only call a model whose key is on).

1. **User named a vendor** ("Use conch", "MiniMax", "Kling", "Seedance") → that `model`, if configured.
2. Else **default `seedance2`** when Seedance is configured.
3. Else if only Kling is on → `kling`. Else if only MiniMax is on → `hailuo`.
4. Switch away from default when:
   - Need **multi-shot customize / intelligence** → `kling` (confirm if not user-named).
   - Need **rich multi-modal refs** (video/audio refs, edit/extend) → `seedance2`.
   - Need a **short single beat** and only MiniMax is available, or user wants Hailuo → `hailuo` with duration 6 or 10.

If the required model is **not configured**, say so and offer: another configured video vendor, upload, or Motion Graphic — do not pretend the API exists.

Briefly tell the user what you will generate before submitting.

## Tool Params

| Param | Values | Default |
| --- | --- | --- |
| `prompt` | video description | required (except Kling customize → use `multiPrompts`) |
| `model` | `seedance2`, `kling`, `hailuo` | seedance2 when available |
| `durationSeconds` | model-specific | seedance/kling ~5; **hailuo 6 or 10** (1080p → 6 only) |
| `ratio` | see model docs | 16:9 (seedance/kling); **ignored on hailuo** |
| `resolution` | `480p`, `512p`, `720p`, `1080p`, `4k` | provider-specific; hailuo adds 512p for Hailuo-02 |
| `refVideoMode` | `feature`, `base` | kling only, with `refVideos` |
| `promptOptimizer` / `fastPretreatment` | boolean | hailuo only |
| `generateAudio`, `seed`, `cameraFixed`, `watermark` | controls | seedance only |
| `returnLastFrame`, `executionExpiresAfter`, `priority` | controls | seedance only; requested last frame becomes another image asset |
| `name` | descriptive asset name | required for good pool UX |
| `firstFrame` | project image asset ref | optional |
| `lastFrame` | project image asset ref | seedance / kling / hailuo (requires firstFrame; not with multi-ref on seedance) |
| `refImages` / `refVideos` / `refAudios` | asset refs | seedance full; kling: images + **1** feature video (no audio); hailuo: none (frames / S2V subject) |
| `mode` / `shotType` / `multiPrompts` | Kling multi-shot | kling only |

Model-specific params — see the model's reference.

## Input Resolution

`firstFrame` / `lastFrame` / `refImages` / `refVideos` / `refAudios` all take a project asset reference. Prefer a full UUID or short prefix from `read_project`; `asset://<id>` and same-project asset URLs returned by `read_project` are also accepted. Per-slot type: frame slots and `refImages` → image; `refVideos` → video; `refAudios` → audio.

External URLs and base64 are not accepted. If the source is a public URL, download it into the project first (`download_media` for video/audio, `submit_image` for images) and pass the resulting asset id.

## Workflow

Four-step loop. For each new generation, restart from Step 1 if the user's intent has shifted.

### Step 1 — Align scope with the user

Before writing any prompt, align on three dimensions:

1. **Duration & segments** — total length, how many shots, and whether they live in one clip or several.

   If the user has already stated a direction ("make a section", "in one video", "Generate separately", "split into N shots", etc.), follow it — don't second-guess.

   Otherwise, surface the two paths and let the user pick:
   - **Multi-shot within one clip** (see model ref) — single inference, subject / lighting / style physically consistent across sub-shots; fits a coherent narrative within the per-clip duration cap.
   - **Multiple clips** — each clip is independently controllable and re-rollable, but identity and style continuity have to be carried by anchors; fits durations beyond the cap or hard scene breaks.

   Offer the trade-off; do not pick for the user.

2. **Content** — what each clip depicts. Summarize back what you understood, segment by segment. When content is vague (e.g. "generate a video of a girl dancing"), the user typically hasn't specified one or more of:
   - **Subject**: who / what is the main subject (appearance, outfit, defining features)?
   - **Action**: what are they doing? (For talking / emotional shots, what micro-expression?)
   - **Scene**: where — setting, time of day, environmental details?
   - **Lighting / color mood**: what atmosphere?
   - **Camera**: any shot-size / angle / movement preference?
   - **Style**: visual style or reference (cinematic / anime / documentary / ...).

   Focus on the items that matter for this specific request and can't be safely inferred — don't turn this into a blank-filling exercise. Summarize the understood parts back to the user before proceeding.

3. **Consistency anchors** — only when multiple shots reuse a character, object, or scene: identify which anchor (reference image or video) to pin across shots. For sourcing rules, see §Visual consistency across shots below.

For each dimension, check the user's words:

- **Clear** — proceed.
- **Ambiguous or missing** — ASK the user. Do not guess, do not default to your own interpretation. A round-trip confirmation is cheaper than a wasted generation.

#### What NOT to do

- **Do not "tell then submit"** — announcing "I'll make this as 2 clips" and immediately submitting is not alignment, it's a unilateral decision with announcement.
- **Do not default to splitting a single-video request into multiple clips.** A single clip can carry multiple sub-shots (see model ref), with subject / lighting / style physically consistent across them. Surface the trade-off, then let the user choose.
- **Do not skip the ask** because you think the answer is obvious.

#### Hard overrides (user's explicit word wins)

- "one clip / single clip / one piece / a shot / in 1 clip" → never split, even if the description is objectively long.
- "N shots / N segment / N shot" → generate exactly N.
- "use this image / Use this picture" → use as reference, don't substitute.

### Step 2 — Write the prompt

See the chosen model's reference for prompt structure and param combinations (e.g., Seedance's 8-element structure and modes; Kling's prompt tips). Before submitting, check:

- `name` is a **descriptive** asset name — descriptive enough for the user (and you in later turns) to recognize this asset in the project library. Avoid vague names like "Untitled" or "clip 1".
- Param combination matches the user's intent — see the **Modes** section in the model's reference.
- Generated video audio is not a tool parameter (provider-side). Hailuo has no ratio/multi-ref; do not invent those params.
- On validation failure, read the error and fix the inputs — **do not blindly retry the same invalid arguments**.

### Step 3 — Submit one, wait, confirm

**Submit one generation job at a time.** Unless the user explicitly asked for multiple clips in parallel, do not submit the next clip until the current one completes and the user has reviewed it. Parallel submission hides problems: if the first shot has drift or wrong framing, the user would rather redo it once than have several misaligned shots to discard.

- `submit_video.ratio` controls the generated asset only; it does not change the project timeline canvas. If the user requested a final output aspect ratio (for example "9:16 vertical" or "16:9 landscape"), set the timeline canvas to the same ratio with `manage_timelines` action=update (e.g. ratio:"9:16") before placing the completed asset. If the user asked for no black bars / full-bleed, pass `fit:"cover"` when setting the canvas or updating/adding the visual item.
- Do not use this skill for job management — use the `track_progress` tool for status/wait.
- After submitting, end your turn (tell the user the job was created) unless a follow-up task is already queued.
- When the job finishes, surface the result to the user for review before proceeding to the next shot.
- Model-specific failure handling — see the model's reference.

### Step 4 — Iterate

When the user wants a next clip, a revision, or a continuation:

- **If it's the next shot in a multi-shot sequence** — reuse the established anchor (see §Visual consistency across shots below for principles, model ref for flag-level details).
- **If the user's feedback is ambiguous** ("it doesn't feel right") — ask what specifically to change before regenerating.
- **If the same text-prompt adjustment has failed twice** — stop adjusting text. Switch to reference images, or switch to edit mode where the model supports it (see model ref).
- Each new generation restarts the loop at Step 1 — realign if scope shifted.

## Visual consistency across shots

Text alone cannot reliably maintain visual identity across shots; visual references constrain output far more precisely than words.

### Anchors: the cornerstone of consistency

An **anchor** is a reference image or video pinned across every shot that shares the same character, object, or style. Any multi-shot sequence with recurring visual elements needs an anchor — don't try to reproduce them from text.

### Sourcing an anchor

Have reference awareness. When the user's request involves a recurring character / object / scene, think about what anchor to use **before** writing prompts:

- **Check the project first.** What has the user already provided or approved? Uploaded images, previously generated and approved shots, or earlier project assets can all serve as anchors.
- **Match the user's intent.** If the user pointed to a specific asset ("use this photo", "like the previous paragraph"), use that. If they described a character only in words, no anchor exists yet and one must be established.
- **When in doubt, ask the user.** Don't guess which asset to pin, and don't silently generate a new anchor when the user may already have one in mind.

### Establishing a new anchor (with user consent)

When no existing asset fits and one must be generated, propose it to the user first — it shapes every downstream shot. Model-specific paths — see the chosen model's ref.

### Using the anchor

- Pass the anchor in **every shot** that shares the character / object / style. The specific flag(s) to use depend on the model — see the model's ref.
- Describe the anchor by appearance in the prompt, not by name: "The BLACK RACING CAR with chrome exhaust" constrains far more than "Fleetmaster". When role confusion is likely, add explicit negations: "The motorcycle does NOT transform."
- Refer to the anchor with `@Image1` / `@Video1` in the prompt — not vague phrases like "the same car as before".
- When a shot depends on a previous generation, **wait for the previous job to complete** (via `track_progress` with `action=wait`) to obtain its `assetId`, then pass it as the anchor reference. Do not submit dependent shots in parallel.

### Multi-character projects

When a project has multiple named characters with distinct attributes (e.g. Faz with fire energy, Kev with ice energy), treat each character as a **separate anchor** — one reference asset per character. In every prompt:

- Name the **active** character and attach their distinctive attributes ("Kev has **blue ice** electric energy").
- Add explicit negations for the others to prevent attribute leakage ("NOT red fire energy, NOT Faz's look").
- Pin the correct character's anchor (model-specific flag — see model ref). Do not reuse another character's anchor by accident.

Missing either explicit attribution or negation causes cross-character attribute mixing.

**Multiple characters in the same frame.** For shots where multiple characters appear together (especially facing the camera), the model is prone to face-swap or body-clipping. Add **strong positional + outfit anchors** to each character and prefer a **fixed camera** for that shot:

- "the character on the LEFT wears a grey-blue tactical jacket, short beard, silver earring"
- "the character on the RIGHT wears a red cape with gold trim, long braided hair"
- "fixed camera, medium shot, both characters clearly separated"

Positional words (left / right / foreground / background) + distinctive outfit colors give the model enough signal to keep the characters apart.

### Escalate when text adjustments fail

If a visual-identity issue (wrong character, drift, color mismatch) persists after **two text-prompt adjustments** on the same shot, stop adjusting text. Text is not a substitute for an anchor. Escalate to:

- Adding or switching the anchor.
- Edit mode where the model supports it (see model ref for how to invoke).

Do **not** submit a third text-only retry on the same consistency issue.

### When to skip anchoring

Simple, one-off, or exploratory requests do not need anchors — generate directly.

## Run

```ts
// Text-to-video (seedance2 default)
submit_video({
  model: "seedance2",
  prompt: "A cat walks across a sunny windowsill",
  name: "Cat on windowsill",
});

// Image-to-video with seedance2 — pass the project asset id directly; the server resolves the asset's media URL
submit_video({
  model: "seedance2",
  prompt: "The scene comes to life, gentle breeze rustles the curtains",
  firstFrame: "abc12345",
  name: "Living room animation",
});

// Kling text-to-video — only after Model Selection check
submit_video({
  model: "kling",
  prompt: "A sports car drifts around a wet corner",
  name: "Car drift shot",
});

// MiniMax Hailuo — 6s or 10s; optional firstFrame / lastFrame (with first)
submit_video({
  model: "hailuo",
  prompt: "A ceramic cup steams on a wooden table, soft morning light [Push in]",
  durationSeconds: 6,
  resolution: "720p",
  name: "Coffee steam morning",
});
```

After submission, call the `track_progress` tool: `action=status jobIds=<jobId>` to poll, `action=wait jobIds=<jobId>` to block until terminal.

## Config Mode

For complex multimodal jobs, build the full args object up front and pass it in a single call:

```ts
submit_video({
  model: "seedance2",
  prompt: "...",
  name: "...",
  firstFrame: "abc12345",
  refImages: ["def67890", "ghi24680"],
  refVideos: ["abc99999"],
  refAudios: ["jkl55555"],
  durationSeconds: 8,
  ratio: "9:16",
});
```

## Rules

- Always provide `--name` with a descriptive asset name.
- Default to submit-only. End your turn after submitting unless a follow-up task is queued.
- Do not call this skill with `--job`, `--wait`, or `--timeout` — job management belongs to `track_progress`.
- Before submitting, briefly tell the user model + duration + what will be generated.
- Place completed assets with `edit_item` only after the user wants them on the timeline (pool-first contract).
