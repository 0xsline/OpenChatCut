---
name: multi-clips-to-reels
description: Turn multiple product shots, event footage, travel clips, gameplay moments, UGC/product footage, B-roll, or mixed media into social-ready reels, highlights, recaps, or montage-style short videos from existing project media.
---

# Multi Clips to Reels

Use this workflow when multiple raw clips or assets carry the output. The task is to select, sequence, and package the strongest footage into one or more reels, highlights, recaps, or short videos.

This is a OpenChatCut-native workflow. Use the current project, source assets, asset-frame inspection, AV/script context, and OpenChatCut editing tools. Use the current timeline when it already contains relevant cuts or for final verification; do not depend on timeline screenshots as the primary way to understand raw source clips. Do not depend on external download, transcription, ffmpeg, or auto-crop pipelines unless the user explicitly asks for an external source that is not already in the project.

## Workflow

1. Read the project state before editing. Inventory usable source assets: duration, aspect ratio, visual subject, motion/energy, audio quality, duplicates, current timeline state when relevant, obvious hero shots, and fixed-role assets such as logos, QR codes, product photos, brand screenshots, or supplied audio.
2. Confirm that multiple clips carry the output. If one long source clearly defines the story and other assets are only support, switch to the Long Video to Shorts workflow.
3. Identify the user's starting point:
   - `open_media_reel`: uploaded clips/photos and a loose goal.
   - `script_or_storyboard`: supplied script, timestamps, shot list, scene notes, or exact copy.
   - `asset_pack_promo`: product/event/place assets with logos, screenshots, QR codes, audio, or brand constraints.
   - `highlight_selection`: many clips where the main work is selecting the strongest visual moments.
4. Determine only missing constraints that would change the edit: platform, output count, target duration, audience, style, captions/title text, music, and whether the user wants options or direct creation.
5. If more than one missing constraint remains, ask for them in one `<widget>` after loading `widget-forms`. Use text fields for open-ended fields like premise, audience, product/context, or goals; use single/multi choice fields for bounded choices like platform, count, duration, captions, or music.
6. Assign source assets a possible role: hook, context, proof, demonstration, emotional beat, transition, payoff, end card, logo/QR, product evidence, or audio bed. Do not assume every uploaded clip deserves screen time.
7. Match the planning style to the starting point. For `script_or_storyboard`, preserve the user's scene order, copy, timestamps, and claims while mapping each source asset to the requested shot. For `asset_pack_promo`, lock the product/place/event identity and reserve fixed-role assets for brand, proof, or CTA moments. For `open_media_reel` and `highlight_selection`, select and sequence the strongest moments instead of averaging every asset.
8. Compare possible hooks and sequences using [references/short-form-selection.md](references/short-form-selection.md). Use `read_script` for the speech/script overview, `view_asset_frames` for specific source frames and frame-block analysis to select high points or verify what happens on screen. Select for strength, variety, continuity, and fit to the requested platform.
9. Build a compact sequence plan before heavy editing. For each output include selected assets/ranges, opening hook, shot order, role of each shot, rhythm, target duration, platform treatment, and risks.
10. If the user gave enough constraints and asked to create directly, proceed after stating the plan. If the material is varied or the requested count is high, create or preview the first strongest reel before batching the rest.
11. Edit around a viewer-facing arc: hook, context, escalation or proof, payoff. For a pure highlight reel, the payoff can be the strongest final moment or a satisfying recap beat.
12. Package for the target platform: aspect ratio/crop, title text, styled captions, music/beat sync, light motion graphics, transitions, speed ramps, or zooms only when they improve rhythm or clarity.
13. QA before reporting done: strongest shot first, clear sequence purpose, distinct outputs, no unsupported claims, platform fit, requested count/duration, timeline names, and export readiness.

## Plan Format

When presenting a plan, use this compact shape:

- Clip/reel number/title
- Starting point: `open_media_reel`, `script_or_storyboard`, `asset_pack_promo`, or `highlight_selection`
- Selected source assets or ranges
- Source evidence used, such as `read_script`, source frames, or visual-analysis notes
- Opening hook visual or line
- Shot order and role of each shot
- Rhythm or sequence shape
- Target duration/platform treatment
- Edit notes and risks

When creating clips, report timeline names, durations, packaging applied, assumptions, and what to review first.

## Rules

- Start with the strongest visual or clearest promise. Do not slowly introduce every asset.
- Trim clips aggressively enough to maintain rhythm, but keep enough context for the sequence to make sense.
- Do not evenly sample every asset.
- Do not build a contextless montage when the user needs a clear reel, recap, or highlight.
- Do not repeat visually similar shots unless repetition creates rhythm or comparison.
- Do not use captions/title text to invent unsupported claims.
- Do not let packaging effects hide weak source selection.
- For multiple requested reels or short videos, create distinct angles instead of near-duplicate edits from the same footage.