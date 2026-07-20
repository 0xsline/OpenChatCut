---
name: music
description: |
  Background-music generation via Mureka and MiniMax. Use when the user wants newly generated music, background music, an intro theme, a music bed, or BGM for a video through `submit_music`.
user-invocable: true
---

# Music

Use `submit_music` to create a new background music audio asset from a text prompt. The tool submits a generation job and returns `jobId`. The audio asset is available after `track_progress` reports completion. Placement, trim, loop, fade, and ducking are timeline tools — not generation.

## Providers

| Provider | Reference | Strengths |
| --- | --- | --- |
| `mureka` | default instrumental | Style/mood BGM bed; instrumental only |
| `minimax` | [references/minimax.md](references/minimax.md) | Instrumental, vocals/`lyrics`, auto lyrics, or **music-cover** via `referenceAssetId` |

**Selection**

1. User named a vendor ("Mureka", "MiniMax", "海螺音乐") → that `provider` if configured.
2. Need **cover / 翻唱** of a project track → `minimax` + `referenceAssetId` (Settings model `music-cover*`).
3. Need **vocals / lyrics** → `minimax` with `lyrics` or `lyricsOptimizer` (Mureka rejects lyrics).
4. Else default **`mureka`** when configured; if only MiniMax is on → `minimax`.
5. If neither is configured, say so and offer library audio / upload.

Respect the capabilities prompt — do not call a vendor that is off.

## Capability Boundary

These models create a **new** music asset. They do not edit, clean, remix, stem-separate, or retarget an existing track. They also cannot guarantee exact beat / drop / timestamp alignment — place and cut on the timeline after the asset exists.

## Tool Params

| Param | Values | Notes |
| --- | --- | --- |
| `prompt` | string | Required. Mureka ≤1024; MiniMax ≤2000 |
| `provider` | `mureka` \| `minimax` | Default `mureka` |
| `lyrics` | string, ≤3500 | **minimax only**. Section tags OK |
| `isInstrumental` | boolean | **minimax only**. Force no-vocals bed |
| `lyricsOptimizer` | boolean | **minimax only**. Auto lyrics from prompt when `lyrics` empty |
| `sampleRate` / `bitrate` / `audioFormat` | enums | **minimax only**. Defaults 44100 / 256000 / mp3 |
| `referenceAssetId` | audio asset id | **minimax music-cover only** — source track to cover |
| `name` | string | Media-pool label |

## Workflow

1. Confirm provider from capabilities + user request (vocals → minimax).
2. Write a concise `prompt` (genre, energy, instrumentation, mood, edit role).
3. For minimax vocals, draft `lyrics` with clear sections; keep instrumental when the user wants BGM under speech.
4. Call `submit_music` with a short descriptive `name` when useful.
5. `track_progress` (`target=generation`, `action=wait` or `status`) until the asset is in the pool.
6. Place / trim / tile / duck with timeline tools (`edit_item`, `edit_track` role `follower`, fades).

## Prompt Shape

Good prompts combine:

- genre or instrumentation: "minimal electronic", "warm acoustic guitar", "cinematic piano"
- energy: "upbeat", "calm", "tense", "confident"
- role: "under a product walkthrough", "intro sting", "background bed under speech"
- constraints: "not distracting", "no vocals", "short loop feel" when needed

## Examples

```ts
// Default instrumental bed (Mureka)
submit_music({
  prompt: "Warm lo-fi piano bed under product narration, calm, no vocals",
  name: "BGM · lo-fi product",
});

// MiniMax instrumental
submit_music({
  provider: "minimax",
  prompt: "Upbeat electronic for a tech intro, driving but not harsh",
  name: "BGM · tech intro",
});

// MiniMax with vocals
submit_music({
  provider: "minimax",
  prompt: "Modern pop, mid-tempo, bright chorus",
  lyrics: "[Verse]\\nCity lights open the night\\n[Chorus]\\nWe build the future in real time",
  name: "Song · city lights",
});

// MiniMax auto lyrics from style prompt
submit_music({
  provider: "minimax",
  prompt: "Rainy night pop about leaving home",
  lyricsOptimizer: true,
  name: "Song · auto lyrics",
});

// MiniMax cover (Settings: MINIMAX_MUSIC_MODEL = music-cover)
submit_music({
  provider: "minimax",
  prompt: "Warm acoustic cover, intimate coffee-shop vibe",
  referenceAssetId: "audioAssetId",
  name: "Cover · acoustic",
});
```

After submission:

```ts
track_progress({ action: "wait", target: "generation", jobIds: "<jobId>" });
```

## Rules

- Only after an explicit music-generation request.
- Do not cover speech with loud music; lower volume or duck under narration (`edit_track` follower / anchor).
- Do not use generated music as a substitute for user-provided copyrighted tracks.
- Do not pass `lyrics` to `mureka`.
- Briefly tell the user style + provider before submitting.
