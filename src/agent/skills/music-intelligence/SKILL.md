---
name: music-intelligence
description: |
  Run or inspect local music analysis and plan or apply beat-, downbeat-, or section-synced video cuts or photo placements.
  Use for BGM beat edits, rhythm cuts, 卡点剪辑, musical structure, BPM, mood, genre, or instrument questions.
user-invocable: false
---

# Music Intelligence

1. Call `analyze_music` when the user asks to analyze music or no cache exists. It runs the installed local Beat This + CLAP models, waits for completion, and never downloads models; use `force:true` only for an explicit reanalysis request.
2. Call `inspect_music` when only the existing cache is needed.
3. Before cutting video, call `music_edit_plan` and show its bounded cut/target summary. Before placing photos, call `music_image_plan` and show its bounded placement summary. Prefer `timing:auto`; choose sparse, medium, or dense from the requested pace.
4. Only after the plan is accepted, call `sync_cuts_to_music` or `sync_images_to_music` with the returned `analysisRef`. Each tool recomputes the plan, rejects stale analysis, and applies its changes as one undo step.
5. If required model packs are missing, report the returned install guidance (Settings path + missing pack names), then ask whether to proceed with a `detect_beats` fallback for pure beat timing (BPM + beat frames only, no CLAP tags/sections/energy), or wait until the user installs the packs and retry `analyze_music` after installation.
6. Never request, return, quote, summarize, or place the CLAP embedding in model context. Use tags, sections, confidence, and the opaque `analysisRef` only.

## Preconditions

- Analysis is opt-in and on-device. The media-pool asset must already have a cache for its current `sourceRevision`.
- `rhythm-lite` supplies Beat This rhythm data; `music-semantics-lite` supplies CLAP tags and the private similarity vector.
- An Agent call must never install a pack, download a model, decode media, or start inference. Direct the user to Settings and the media-card analysis action when the cache is unavailable.

## Inspect

- Identify the BGM by `itemId`, `assetId`, or an unambiguous name. Prefer the timeline item when the user intends to edit, because returned points are then mapped to timeline frames through the clip trim and playback rate.
- `inspect_music` returns BPM, meter, confidence, tags, sections, counts, and bounded point lists. Lists are capped at 48 beats, 24 downbeats, 16 sections, and 12 tags; use a narrower range when `truncated` is true.
- Treat `analysisRef` as opaque. It binds later planning and execution to the exact cached analysis without exposing the 512-value CLAP embedding.

## Plan

- `timing:auto` chooses section → downbeat → beat for sparse edits, downbeat → beat → section for medium edits, and beat → downbeat → section for dense edits.
- Density samples every fourth, second, or first candidate for sparse, medium, or dense respectively.
- Plans are bounded to 96 cut frames and 64 overlapping video targets. Report the returned summary and any cap or locked-target warning before applying.
- A plan targets video clips that overlap the selected BGM range. It must never include or mutate the BGM item itself.

## Photo placement

- `music_image_plan` uses explicitly listed image asset ids in their given order, or all image assets in media-pool order when omitted. It cycles that order when the music range has more beat intervals than images.
- Each placement covers the complete interval from one selected timing point to the next, including the BGM range boundaries, so images are not appended with their source duration or placed at a uniform default length.
- Image placement is bounded to 96 clips and 64 image assets. `sync_images_to_music` requires an unlocked, empty target video track for the requested range; choose another track instead of overwriting existing content.

## Apply and recover

- Pass the same `itemId`, timing, density, range, target ids, and `analysisRef` to `sync_cuts_to_music`. Execution recomputes the plan from current state; do not replay an old list of frames.
- A missing or stale ref means the project or analysis changed. Call `inspect_music`, then `music_edit_plan` or `music_image_plan`, and ask for acceptance again.
- Locked video tracks are skipped and reported. Never unlock a track implicitly.
- Successful splits are submitted as one `EditorCommands.batch`, so the whole rhythm edit is one undo step.
- Successful photo placements are submitted as one `EditorCommands.batch`, so the whole sequence is one undo step.
