---
name: music
description: |
  Shared ChatCut background-music generation skill. Use when the user wants newly generated music, background music, an intro theme, a music bed, or BGM for a ChatCut video through `submit_music`.
user-invocable: true
---

# Music

Use `submit_music` to create a new background music audio asset from a text prompt. In the native SDK this may appear as `submit_music`; in the Codex connector it appears as `submit_music`.

The tool submits a generation job and returns `jobId`. The generated audio asset is available after `track_progress` reports completion.

## Capability Boundary

Mureka is a music generation model. It creates a new original music asset; it does not edit, clean up, remix, separate, or adjust existing audio.

Mureka also cannot guarantee exact beat, drop, or timestamp alignment. Generate the music asset first, then use timeline tools for placement, trimming, looping, fades, and ducking. If the user requires precise beat-level sync, explain that this must be handled as a timeline/audio edit rather than guaranteed by the generation model.

## Workflow

1. Write a concise prompt describing style, energy, instrumentation, mood, tempo, and edit role.
2. Provide a short descriptive `name` when useful.
3. Call `submit_music`.
4. Use `track_progress` if the next edit needs the completed asset.
5. Place, trim, loop, or duck the audio with timeline tools after the asset exists.

## Prompt Shape

Good prompts combine:

- genre or instrumentation: "minimal electronic", "warm acoustic guitar", "cinematic piano"
- energy: "upbeat", "calm", "tense", "confident"
- role: "under a product walkthrough", "intro sting", "background bed under speech"
- constraints: "not distracting", "no vocals", "short loop feel" when needed

## Rules

- Do not cover speech with loud music; lower volume or duck under narration.
- Do not use generated music as a substitute for user-provided copyrighted tracks.
