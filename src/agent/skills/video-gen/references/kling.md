# Kling (`kling`)

Read this before `submit_video({ model: "kling", … })`.

Grounded in OpenChatCut’s video adapter (`server/plugins/video.ts` → Kling
`POST /v1/videos/omni-video`, default model `kling-v3-omni`). Official Omni
capabilities (multi-shot, first/last frame, image refs, `<<<image_n>>>` tokens)
are mapped to our tool shape below. **Do not promise** features we do not
forward (video refs, element library, voice binding, Motion Brush, etc.).

Call it **"Kling"** for the user — do not surface internal aliases (V3 / O3 /
O1 / 2.6 / Turbo).

## Capabilities (as wired)

| Dimension | Value |
| --- | --- |
| Endpoint task | `omni-video` only |
| Duration | **3–15** seconds integer (default **5**) |
| Aspect ratio | `16:9`, `9:16`, `1:1` |
| Quality mode | `std` → ~720p · `pro` → ~1080p (see `mode` / `resolution`) |
| Top-level prompt | ≤ **2500** characters (required unless `shotType=customize`) |
| Per-shot prompt | ≤ **512** characters when using `multiPrompts` |
| Images | ≤ **7** total without video; ≤ **4** when `refVideos` is set |
| Image formats (provider) | JPEG/JPG/PNG; roughly 300–8000 px side; ≤ ~10MB (import to project first) |
| Reference video | **At most 1** via `refVideos` → API `video_list` |
| `refVideoMode` | `feature` (default) or `base` — only with `refVideos` |
| Multi-shot | **2–6** shots via `shotType` + optional `multiPrompts` |
| `refAudios` | **Rejected** |
| Element library / voice IDs | **Not wired** |
| `negative_prompt` field | **Not sent** — put avoidances in the prompt text |

### `mode` ↔ `resolution`

| Intent | Set |
| --- | --- |
| Standard / faster | `mode: "std"` or `resolution: "720p"` (default) |
| Higher fidelity | `mode: "pro"` or `resolution: "1080p"` |

If **both** are set, they must agree (`pro` ⇔ `1080p`); otherwise the server
throws `kling mode and resolution conflict`. Prefer setting only one.

## Input channels → provider lists

| Tool param | Provider entry | Prompt token (after rewrite) |
| --- | --- | --- |
| `firstFrame` | `image_list[]` `{ type: "first_frame", image_url }` | `<<<image_1>>>` if first image |
| `lastFrame` | `image_list[]` `{ type: "end_frame", image_url }` | next image ordinal |
| `refImages[]` | `image_list[]` `{ image_url }` | following ordinals |
| `refVideos[]` | `video_list[]` `{ video_url, refer_type }` | `<<<video_1>>>` (max 1) |
| `refVideoMode` | `feature` (default) or `base` | feature = motion/camera/style; base = edit source (`keep_original_sound: yes`) |

**Rules**

- `lastFrame` **requires** `firstFrame`.
- All slots are **project asset refs** (UUID / prefix / `asset://…`). External URLs rejected — import first.
- In the **prompt**, use `@Image1` / `@图片1` and `@Video1` / `@视频1`. Our server rewrites to `<<<image_N>>>` / `<<<video_N>>>`. Image ordinals: firstFrame → lastFrame → refImages[0]…. Video ordinals start at 1 for `refVideos[0]`.
- With a feature video: keep **≤4** stills total; describe what to take from the video (camera, motion, rhythm) in the prompt.

Always attach a noun after the token: `@Image1 character walks…`, not bare `@Image1 walks…`.

## Modes

| Params | Mode | Notes |
| --- | --- | --- |
| `prompt` only | text-to-video | Single continuous clip |
| `firstFrame` + `prompt` | image-to-video | Animate from start still |
| `firstFrame` + `lastFrame` + `prompt` | first→last | Strict start/end frames |
| `prompt` + `refImages` (± frames) | reference-guided | Subject/style anchors; ≤7 images total |
| `prompt` + `refVideos` (± ≤4 images) | video feature ref | Default `refVideoMode: "feature"` — motion/camera/style |
| `prompt` + `refVideos` + `refVideoMode: "base"` | video edit | Edit/replace elements in that clip; source audio kept when possible |
| `shotType: "intelligence"` + `prompt` | multi-shot auto | Model plans cuts; 2–6 internal shots |
| `shotType: "customize"` + `multiPrompts` | multi-shot manual | **Omit** top-level `prompt` |

### Multi-shot (official contract → our tool)

Official Omni multi-shot: `multi_shot: true`, `shot_type`, optional `multi_prompt[]`.
We set those when you pass `shotType`.

#### `shotType: "intelligence"`

- Pass a **single** top-level `prompt` that describes the whole sequence.
- Model auto-decomposes into shots (up to 6).
- Use when the user wants quick multi-cut coverage without per-shot durations.
- Still write technical shot language (size / camera / motion settle) inside that one prompt when quality matters.

```ts
submit_video({
  model: "kling",
  shotType: "intelligence",
  durationSeconds: 10,
  ratio: "9:16",
  prompt:
    "Two-shot dialogue then CU reaction. Shot reverse shot. " +
    "MCU on speaker A, then B. Soft key camera-left 4500K. " +
    "Motion settles as B looks down, breath steadies.",
  name: "Dialogue · intelligence multi",
});
```

#### `shotType: "customize"`

Server validation (matches official customize):

| Rule | Detail |
| --- | --- |
| Top-level `prompt` | **Must be omitted** (empty) |
| Shot count | **2–6** entries in `multiPrompts` |
| `index` | 1-based, consecutive (`1…N`) |
| Per-shot `prompt` | Non-empty, ≤ **512** chars |
| Per-shot `duration` | Integer ≥ **1** |
| Sum of durations | **Exactly** `durationSeconds` |

```ts
submit_video({
  model: "kling",
  shotType: "customize",
  durationSeconds: 12,
  ratio: "16:9",
  mode: "std",
  multiPrompts: [
    {
      index: 1,
      duration: 4,
      prompt:
        "[Shot 1] WS. Slow dolly in. Key from camera-left window, 4500K warm amber. " +
        "Woman in grey coat enters cafe. Motion settles as she reaches the counter.",
    },
    {
      index: 2,
      duration: 4,
      prompt:
        "[Shot 2] MCU. Static. Same woman, grey coat, short dark hair. She smiles at barista. " +
        "Motion settles as steam rises past her face.",
    },
    {
      index: 3,
      duration: 4,
      prompt:
        "[Shot 3] CU. Very slow push-in. Hands take a paper cup. " +
        "Motion settles as both hands cradle the cup center-frame.",
    },
  ],
  name: "Cafe storyboard · 3 shots",
});
```

Repeat **identity details in every shot prompt** (coat color, hair, age cues). Multi-shot preserves identity better than separate jobs, but each shot is still its own brief — do not assume shot 2 “remembers” shot 1’s prose.

Optional: same `refImages` / `firstFrame` on a customize job to lock appearance across the storyboard.

## Prompt craft (technical-script model)

Kling does **not** invent missing camera grammar. Explicit structure fixes most failures. Stack these rules:

### 1. Motion endpoint — every shot

End with `Motion settles as <concrete end state>`. Missing endpoints often stall near completion or cut off mid-action.

```
✗ A woman walks a rainy alley under neon.
✓ A woman walks a rainy alley under neon.
  Motion settles as she pauses under a red lantern, face half-turned to camera.
```

Applies to single-shot, I2V, intelligence, and **each** customize entry.

### 2. Shot size in English

Open with a Hollywood size (abbrev OK):

| Size | Abbr | Use |
| --- | --- | --- |
| Extreme close-up | ECU | Eye, hand detail |
| Close-up | CU | Face / object |
| Medium close-up | MCU | Head + shoulders |
| Medium shot | MS | Waist up |
| Medium long | MLS | Full body mid-distance |
| Wide shot | WS | Environment establish |

### 3. Camera movement (declare ≥1; `static` counts)

| Category | Terms |
| --- | --- |
| Static | `static` |
| Push/pull | dolly in/out, pull back |
| Pan/tilt | pan left/right, tilt up/down |
| Track | lateral tracking, following |
| Orbit | slow 180 orbit (avoid on fast action) |

Speed: `very slow / slow / medium / fast / whip`. Max ~2 moves per shot.

### 4. Lighting triplet

Always: **direction + Kelvin + tone**  
e.g. `key from camera-left window, 4500K, warm amber`.  
“Warm light” alone → face/shadow drift.

### 5. Sequential action

Use `First / Then / Finally` for multi-step motion inside one shot.

### 6. Time slicing (≥5s shots)

```
[Shot 2 / MCU / 6s]
  - 0–2s: …
  - 2–4s: …
  - 4–6s: …
Motion settles as …
```

### 7. Emotions → ≥3 physical signals

| Emotion | Signals (pick 3+) |
| --- | --- |
| Sad | glistening eyes, trembling lower lip, shallow breath, loose fingers |
| Scared | wide eyes, breath catch, forehead sweat, hand tremor |
| Happy | eye-corner crinkles, asymmetric smile, relaxed shoulders, soft exhale |
| Angry | clenched jaw, flared nostrils, white knuckles, quick breath |

### 8. Complexity ceiling

~≤7 “elements” per shot (characters, independent events, strong BG actions). Over limit → split shots (prefer customize multi-shot).

### Bilingual split

Narrative can be CN/EN; keep technical directives in English when possible:
`Camera`, `Lighting`, `Motion settles`, `@ImageN` / rewritten `<<<image_n>>>`.

### Avoidances (no negative_prompt field)

Bake into prompt: `Avoid: blurry hands, extra fingers, warped face, text distortion.`

## Multi-character

Attribute leak is common. Every shared-frame prompt needs:

- Position (`LEFT` / `RIGHT` / foreground)
- Distinct outfit + traits
- Explicit **NOT** clauses for the other character
- Prefer **fixed** or very slow camera

```
LEFT: @Image1 man — grey-blue tactical jacket, short beard. NOT red cape, NOT braid.
RIGHT: @Image2 woman — red cape gold trim, long braid. NOT grey jacket, NOT short beard.
Camera: fixed MS, both fully separated.
Motion settles as both face camera, still.
```

## Real-person / product stills

Best refs: frontal (~0–15°), ≥1024² when possible, even light, little occlusion.  
Pass as `firstFrame` and/or `refImages`; mention `@Image1` in the prompt.

## Cross-job continuity (separate `submit_video` calls)

Prefer **one customize multi-shot job** for 2–6 related cuts. If the user forces separate jobs:

1. Keep the same `refImages` on every call.
2. After shot N succeeds, use a frozen frame of the result as the next `firstFrame` when continuity is critical.
3. `track_progress` wait before dependent jobs.
4. After **two** text-only retries on identity drift → change/add refs, not more adjectives.

## When to pick Kling vs Seedance vs Hailuo

| Need | Prefer |
| --- | --- |
| Per-shot duration control / formal storyboard API | **kling** `customize` |
| Auto multi-cut from one paragraph | **kling** `intelligence` |
| Fine face performance / technical camera language | **kling** |
| One motion/camera feature video + stills | **kling** `refVideos` (1) |
| Multi video/audio refs, edit/extend/bridge | **seedance2** |
| Simple 6s/10s T2V or single still I2V | **hailuo** |

## Not wired (do not promise)

| Feature | Status |
| --- | --- |
| Multiple `refVideos` | Max **1** video |
| `refAudios` | Rejected for Kling |
| Element library (`@Element` / element_id) | Not uploaded / not sent |
| Voice binding / voice clone IDs | Not sent |
| Motion Brush (web UI) | N/A |
| Separate audio on/off flag | Not exposed |

For multi-video bridge/edit or audio refs, prefer **seedance2**.

## Errors (server / provider)

| Message / pattern | Fix |
| --- | --- |
| `omit prompt for kling customize; use multiPrompts` | Clear top-level prompt; fill `multiPrompts` |
| `kling customize requires 2 to 6 multiPrompts` | Shot count 2–6 |
| `kling multiPrompt indexes must be consecutive from 1` | `index: 1…N` no gaps |
| `each kling multiPrompt requires a prompt of at most 512 characters` | Shorten per-shot text |
| `kling multiPrompt durations must sum to durationSeconds` | Rebalance durations |
| `kling multiPrompts require shotType=customize` | Set `shotType: "customize"` |
| `kling accepts at most 7 images` | Drop frames/refs |
| `kling with refVideos accepts at most 4 images` | Drop stills or drop the feature video |
| `kling accepts at most 1 reference video` | Keep a single `refVideos` entry |
| `kling does not support refAudios` | Drop audio refs; use Seedance if needed |
| `kling mode and resolution conflict` | Align mode ↔ resolution |
| `prompt is required` | Non-customize paths need prompt |
| `kling prompt must be at most 2500 characters` | Shorten |
| 99% stall / abrupt end | Add **Motion settles** endpoint |
| Face drift across jobs | Same refs + wait; or one customize multi-shot |

## Tool checklist

1. Kling key on (capabilities); `model: "kling"`.
2. Mode combo valid (no Seedance-only ratio like `21:9` / `adaptive`).
3. Images ≤7; no video/audio refs.
4. Customize ⇔ empty prompt + valid multiPrompts sum.
5. Every shot prompt has size + camera + light + **Motion settles**.
6. Descriptive `name` for the media pool.
7. Tell the user model + duration + multi-shot style briefly, then submit once.
8. `track_progress` for job completion; place with `edit_item` only when asked.

## Quick single-shot example

```ts
submit_video({
  model: "kling",
  prompt:
    "MCU. Slow dolly in. Key from camera-left, 5000K neutral. " +
    "@Image1 young man in navy hoodie reads a letter; eyes glisten, jaw tight, breath shallow. " +
    "Motion settles as he lowers the letter, gaze off-camera right. " +
    "Avoid: extra fingers, warped text on paper.",
  firstFrame: "portraitAssetId",
  durationSeconds: 5,
  ratio: "9:16",
  mode: "pro",
  name: "Letter reaction · MCU",
});
```
