---
name: beat-sync-montage
description: |
  Plan and build a finished beat-synced montage where cut placement serves the content, not just the metronome.
  Use for 卡点混剪, 卡点剪辑, 踩点视频, beat-sync montage, rhythm edit, 节奏剪辑, 音乐驱动剪辑, or when the user wants cuts that land on the beat.
---

# Beat Sync Montage

Use this workflow when the edit should be driven by music. The failure mode to
avoid is a metronome edit: every cut technically lands on a beat, and the result
still feels mechanical, tiring, or unrelated to what is on screen.

This workflow decides **what** to cut and **why**. It does not re-explain the
music tools — when you reach an execution step, follow `music-intelligence` for
`analyze_music`, `music_edit_plan`, and `sync_cuts_to_music`. Load it there.

This is a OpenChatCut-native workflow. Use the current project, source assets,
asset-frame inspection, AV/script context, and OpenChatCut editing tools.

## When to switch workflows

- Beat-synced photos on a locked, empty track → `music-intelligence` handles this directly with `music_image_plan`. This workflow is for video montage.
- One long source cut to speech rhythm → `long-video-to-shorts`.
- Many clips packaged as highlights without music driving the cut → `multi-clips-to-reels`.
- N distinct beat-synced variants from one pool → `batch-montage-variants`, using this workflow for each cut.

## Workflow

1. Confirm the track is on the timeline and identified. Read the music first: BPM, meter, sections, and energy shape. Use `music-intelligence` → `analyze_music` or `inspect_music`; never request the CLAP embedding.
2. Judge whether the material actually suits a beat edit. See [references/shot-fitness.md](references/shot-fitness.md). Footage with no clear motion onset, or whose motion contradicts the music's energy, will not improve by cutting on every beat. Say so instead of forcing it.
3. Choose the **density arc** before choosing individual cut points. See [references/beat-density.md](references/beat-density.md). Density is a property of the whole piece, not a per-cut decision: a verse and a chorus should not be cut the same way.
4. Assign content to the music's structure. Map sections to narrative roles — intro to the hook, verse to context, build to escalation, drop/chorus to payoff. Cut density follows that map.
5. Pick the anchor points first: 3–6 moments where a cut must hit a downbeat or a section boundary because the content has real impact there. See [references/beat-density.md](references/beat-density.md). Everything else is filler rhythm between anchors.
6. Fill between anchors at the density chosen for that section. Do not fill uniformly — uniform filling is what makes an edit feel mechanical.
7. Reserve breathing room. See [references/beat-density.md](references/beat-density.md). A montage that never stops cutting exhausts the viewer and hides the anchors you built in step 5.
8. Check motion continuity across cuts. See [references/shot-fitness.md](references/shot-fitness.md). Consecutive cuts should not fight each other in screen direction or motion axis unless the collision is deliberate.
9. Plan with `music_edit_plan`, show the bounded summary and any cap warning, and get acceptance. Then apply with `sync_cuts_to_music` and the returned `analysisRef`. Follow `music-intelligence` for both.
10. QA by watching, not by counting. See the rules below. A cut list that is 100% on-beat can still be a bad edit.

## Plan Format

- Track, BPM, meter, section map with timecodes
- Density arc per section (sparse / medium / dense / rest)
- Anchor points: frame, musical event, and what lands there
- Shot order with the reason each shot sits where it does
- Breathing points: where the edit deliberately stops cutting
- Risks: weak motion onsets, motion-direction collisions, sections that outrun the material

## Rules

- **Anchors over uniformity.** Three or four meaningful downbeat hits beat forty evenly spaced ones.
- **Density follows the music, not the maximum.** Dense cutting is a choice for a section, not a default for the piece.
- **Never cut a strong shot short to satisfy a beat.** If a moment needs four beats, give it four beats and adjust around it.
- **Protect the hook.** The first downbeat hit should land within the first three seconds. A beat edit that eases in has wasted its advantage.
- **Breathe.** At least one held shot per 15 seconds unless the brief explicitly asks for relentless pace.
- **Motion must be legible.** A cut that lands on a beat but lands mid-action with no visible onset reads as an error, not as rhythm.
- **The cut serves the content.** If a section has nothing worth cutting, hold the shot and let the music carry it.
- Do not use captions to invent claims the footage does not support.
- Report honestly when the material does not support the requested density.
