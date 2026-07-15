# Voiceover Video Sync

Use this reference from the `voice` skill when existing visuals drive narration
timing. The job is not just generating TTS; it is making the spoken meaning line
up with what is on screen.

## When to Use

- The user has an existing video, timeline, screen recording, slide animation,
  product demo, B-roll edit, MG explainer, or similar visual sequence.
- The user provides narration text, asks you to write narration, or asks to add,
  replace, redo, dub, or generate voiceover for that visual sequence.
- The timeline already has narration/voiceover and the user asks to trim, speed
  up, slow down, reorder, replace, or retime the visuals while keeping the
  existing voiceover aligned.
- The video has meaningful visual sections: slide changes, product states,
  screen steps, chart/data moments, scene cuts, action beats, or key visual
  events.

Do not wait for the user to explicitly ask for sync. If there is a visual target,
assume the narration should respect the visual content and pacing unless the user
only wants a standalone audio asset.

Do not use this as the main path for cutting original human speech. Use the
talking-head workflow for editing existing spoken content.

## Workflow

1. Read the project state and identify the exact visual target: timeline range,
   video asset, selected item, or full composition. If multiple candidates are
   plausible, ask which one should receive voiceover.
2. Check whether the conversation already contains a usable narration plan,
   storyboard, or script table. Treat it as a draft sync map, not as approved
   TTS input. Reuse it only when it names visual anchors and time ranges for the
   same current visual target. If the target changed, the table is missing
   visual evidence, or any boundary is only a guess, verify only the missing or
   uncertain boundaries instead of restarting the whole visual review.
3. Keep the sync map tied to the current visual state. If an edit changes where
   visual content appears after the map was made, mark the affected rows stale.
   Before placing or reusing voiceover, rebuild or patch those rows from the
   current timeline/asset state. Do not keep using old visual windows after a
   visual retiming edit.
4. Understand the visuals before generating audio. Use project reads, timeline
   screenshots, and `view_asset_frames` for source-frame sampling when needed.
   Segment the target by visible content changes, not by arbitrary equal
   intervals.
5. Build a visual-voiceover sync map from actual visual evidence. Do not
   generate TTS or place voiceover until every segment has a confirmed visual
   anchor and placement start frame/time. For each segment, record:
   - visual start/end frame or time
   - visual anchor: slide title, product state, screen action, chart/data point,
     scene content, or event
   - evidence: inspected frame/time, screenshot, or visual-analysis result
   - narration text assigned to that visual moment
   - target duration and estimated TTS duration
   - fit status: fits / too long / uncertain
   - voiceover placement start frame or time
   - confidence or uncertainty
6. Split or write narration to fit the visual map. Keep each TTS segment tied to
   one visual segment or one intentional multi-shot beat. Do not create one long
   audio file for a video with multiple visual states. Before submitting TTS,
   map each narration line to a visual segment and check that the estimated TTS
   duration is plausibly short enough for its visual window. For short windows,
   prefer phrase-length copy over full sentences. Do not submit TTS for a line
   whose fit status is `too long` or `uncertain` until you tighten the wording,
   split the line, adjust supported speed, or ask the user to approve the timing
   tradeoff.
7. Follow the `voice` skill's audition workflow if the user has not picked a
   voice. Generate TTS per mapped segment.
8. After each TTS segment finishes, read the real audio duration before placing
   it. If the real duration exceeds its visual window or would make the
   narration describe a visual that is not currently on screen, do not place it
   on the timeline yet. Fix the mismatch before final delivery:
   - tighten or split narration
   - adjust speech speed when supported and natural
   - shift the placement to a better visual range
   - extend or hold a visual only when that preserves the edit
   - ask the user when the tradeoff changes meaning or style
9. Place each voiceover segment only after the actual-duration fit check passes.
   Place it at the matching visual start time from the current sync map. If
   original audio, music, or sound effects exist, decide whether to mute, duck,
   replace, or mix them based on user intent.
10. After patching or rebuilding stale rows, read back the updated timeline
    positions before claiming the edit is done. Confirm that caption text, spoken
    content, visual segment, placement, and actual audio duration still
    correspond.
11. Run a final coverage check before delivery. Every visual segment the user
    expected to be explained should either have matching voiceover or an explicit
    reason for silence. Voiceover should not start before its visual appears, and
    old voiceover should not remain over footage whose timing changed. If the
    turn changed any narration-backed visual timing, include a `Final sync check`
    in the response before saying the edit is complete.
12. Verify after placement. Read back item start/end/duration and inspect
    representative frames around each segment start, middle, and end. Preview or
    screenshot enough of the timeline to confirm the spoken meaning and current
    visual information match.

## Rules

- Do not drop a single generated narration track over a multi-section video and
  call it done.
- Do not let a TTS segment talk about a visual that has already disappeared or
  has not appeared yet.
- Do not rewrite user-provided narration in a way that changes claims, names,
  numbers, or intended meaning just to fit timing. Ask or preserve meaning.
- Do not cover meaningful original speech unless the user asked to replace,
  dub, mute, or voice over it.
- Do not treat slide/video length as enough evidence. Use visible anchors and
  content changes.
- Do not treat a script table or narration draft as ready-to-submit TTS input
  until each line has been mapped to a visual segment and checked against that
  segment's target duration.
- Do not use equal division or rough duration estimates as placement
  boundaries. If a boundary is only estimated, inspect more frames around that
  range until the content-change frame is confirmed, or ask the user to approve
  the approximation.
- Do not silently switch from visual-driven sync to narration-driven timing.
  That changes the edit contract. Ask the user before extending visuals,
  allowing desync, overlapping voiceover, or letting narration timing drive the
  cut.
- Do not treat a generated TTS asset as ready for placement just because it
  completed successfully. Real audio duration must pass the sync map's fit check
  first.
- Do not reuse a sync map after timeline or visual-source edits changed where
  visual content appears. Patch or rebuild the affected rows first.
- Do not report completion until expected voiceover coverage has been checked
  against the current timeline.
- Do not end a retiming turn immediately after timeline edits. First read back
  the updated item positions and report a `Final sync check` for each changed
  visual/voiceover pair.

## Output Format

When planning or reporting execution, use this compact shape:

- `target_visual`: asset/item/timeline range
- `segments`: visual range, visual anchor, narration text, TTS asset, audio
  duration, target duration, estimated duration, fit status, placement range,
  mismatch handling, map status
- `mix`: what happened to original audio/music
- `Final sync check`: pass/fail per segment, stale-map fixes, coverage gaps, and
  any timing fixes applied
