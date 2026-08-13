---
name: music-intelligence
description: |
  Run or inspect local music analysis and plan or apply beat-, downbeat-, or section-synced video cuts.
  Use for BGM beat edits, rhythm cuts, 卡点剪辑, musical structure, BPM, mood, genre, or instrument questions.
user-invocable: false
---

# Music Intelligence

1. Call `analyze_music` when the user asks to analyze music or no cache exists. It runs the installed local Beat This + CLAP models, waits for completion, and never downloads models; use `force:true` only for an explicit reanalysis request.
2. Call `inspect_music` when only the existing cache is needed.
3. Before editing, call `music_edit_plan` and show its bounded cut/target summary. Prefer `timing:auto`; choose sparse, medium, or dense from the requested pace.
4. Only after the plan is accepted, call `sync_cuts_to_music` with the returned `analysisRef`. It recomputes the plan, rejects stale analysis, skips locked video tracks, and applies all splits as one undo step.
5. If required model packs are missing, report the returned install guidance, then retry `analyze_music` after installation.
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

## Apply and recover

- Pass the same `itemId`, timing, density, range, target ids, and `analysisRef` to `sync_cuts_to_music`. Execution recomputes the plan from current state; do not replay an old list of frames.
- A missing or stale ref means the project or analysis changed. Call `inspect_music`, then `music_edit_plan`, and ask for acceptance again.
- Locked video tracks are skipped and reported. Never unlock a track implicitly.
- Successful splits are submitted as one `EditorCommands.batch`, so the whole rhythm edit is one undo step.
