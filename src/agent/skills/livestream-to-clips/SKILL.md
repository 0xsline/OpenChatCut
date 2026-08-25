---
name: livestream-to-clips
description: Cut an imported livestream recording of any genre into evidence-backed, platform-ready clips by combining transcript, visual, audio, interaction, and domain-specific signals. Use for commerce, gaming, talk, interview, education, entertainment, sports, music, IRL, creative, news, or mixed livestream recordings.
---

# Livestream to Clips

Use this workflow when the source is an imported livestream recording and the user wants clips, highlights, cutdowns, reels, or multiple publishable timelines. A livestream may change genre during one recording, so classify each section rather than assigning one label to the whole source.

This workflow is OpenChatCut-native. Use project media, transcript, representative source frames, timeline tools, captions, and export tools already available in the editor. Treat audience chat, reactions, score data, product records, or stream markers as optional evidence when the project contains them.

## Required References

Load only the files needed for the current step:

- Read [references/profile-matrix.md](references/profile-matrix.md) before classifying sections or applying genre rules.
- Read [references/multimodal-selection.md](references/multimodal-selection.md) before comparing candidates or processing a long recording.
- Read [references/qa-and-evaluation.md](references/qa-and-evaluation.md) before final verification or benchmark reporting.

## Workflow

### 1. Establish the editing contract

Read the project before editing. Identify the dominant livestream asset, duration, aspect ratio, language, speakers, transcript readiness, audio tracks, existing visual descriptions, and current timeline.

Determine only constraints that change the result: target platform, objective, clip count, duration range, aspect ratio, captions, packaging style, and whether the user wants contiguous source clips or an editorial remix. If the user asked for direct creation and supplied enough context, proceed without another approval step.

### 2. Build a stream map before selecting clips

For a long source, inspect it hierarchically instead of sending the entire transcript or dense frame sequence through one decision pass:

1. Read the transcript in bounded ranges and produce a coarse stream map.
2. Split on topic, activity, speaker, product, round, scene, performance, or format changes.
3. Assign a profile and confidence to each section. Use `mixed` when adjacent profiles overlap.
4. Record important entities and state: people, products, teams, scores, locations, tasks, claims, prices, and outcomes.
5. Preserve source timestamps so every later decision remains traceable.

Do not rank clips yet. First make sure the map covers the beginning, middle, and end of the recording and does not overrepresent transcript-rich sections while ignoring visual or musical events.

### 3. Discover events with all available evidence

Generate event candidates from independent signals:

- **Speech:** question, answer, claim, story, instruction, joke, conflict, reveal, offer, call to action, or conclusion.
- **Visual:** action, product demonstration, score change, reveal, scene novelty, facial reaction, screen result, or completed work.
- **Audio:** laughter, cheering, shout, impact, game cue, musical build/drop, silence contrast, or emotion change.
- **Interaction:** chat/message burst, repeated emote or phrase, donation, poll, viewer request, or streamer response.
- **Metadata:** chapters, markers, score/telemetry, product identifiers, or known agenda items.

Interaction and metadata are supporting signals, not mandatory inputs. Never invent absent chat, telemetry, product, or score evidence.

Treat music intelligence as an enhancement: call `analyze_music` with `optional: true`. If it reports `available: false`, continue with `detect_beats`, waveform/audio cues, and visual timing rather than blocking the clip.

### 4. Turn each event into a complete candidate arc

Expand the event to the smallest source range that preserves its meaning and payoff. Use the profile-specific arc from `profile-matrix.md`. Common shapes include:

- setup → trigger → peak → reaction → outcome;
- question → answer → evidence/example → conclusion;
- product → need → demonstration/proof → offer/CTA;
- goal → explanation/steps → visible result;
- musical phrase/build → chorus/drop → resolution.

Resolve boundaries on clean word, phrase, action, shot, beat, or state-transition points. Include pre-roll when the event is confusing without setup and post-roll when the reaction or result carries the value.

### 5. Create an evidence ledger

Before heavy editing, record a compact candidate ledger. For every candidate include:

```json
{
  "sourceRange": [0, 0],
  "profile": "talk",
  "profileConfidence": 0,
  "event": "",
  "arc": { "setup": [], "peak": [], "payoff": [] },
  "evidence": { "speech": [], "visual": [], "audio": [], "interaction": [], "metadata": [] },
  "missingEvidence": [],
  "openingHook": "",
  "standaloneReason": "",
  "riskFlags": [],
  "targetDuration": 0,
  "packaging": ""
}
```

Inspect representative source frames for serious candidates. Use one `view_asset_frames` call per candidate range with at most six samples covering the opening, peak, payoff, and one meaningful visual transition. Reuse that contact sheet; repeat only after extraction failure or a changed source range. A transcript-only candidate is provisional until visual evidence confirms that the range is usable, unless the source is intentionally audio-first.

### 6. Reject, score, and diversify

Apply hard rejection gates before ranking. Reject or flag candidates with changed meaning, missing payoff, mismatched product/score/person, unresolved factual numbers, severe black/frozen/obscured frames, broken audio, unsafe disclosure, or boundaries that cut essential context.

Score the remaining candidates using the profile weights in `multimodal-selection.md`. Missing optional evidence is marked `unavailable`; it is not scored as failure. Select a diverse set across topics, products, rounds, speakers, event shapes, and visual treatments. Avoid near-duplicate excerpts even when all score highly.

When the source is long, the style is unsettled, or many outputs are requested, create and verify the highest-ranked clip first. Use the proven treatment as the batch reference, then continue with the remaining candidates.

### 7. Edit for the selected profile

Create every approved output as its own named Sequence. Batch-create them with one `manage_timelines` call using `action:"create"` and `timelines:[...]`, then switch to each returned timeline and add the selected range from the original asset with `sourceStartFrame` and `sourceDurationInFrames`. Reuse the original `sourceAssetId`; do not copy the long recording. Keep edits reversible and source-linked.

- Tighten filler, false starts, repeated attempts, and dead time only when speech remains natural and intent is preserved.
- Hide necessary jump cuts with an appropriate reaction shot, source cutaway, crop change, or subtle scale change when the evidence supports it.
- Reframe around the viewer's task: face, product, gameplay/UI, demonstration, instrument, slide, or result.
- For landscape-to-vertical edits, split at shot or layout changes and choose the crop per segment. A speaker close-up may use a centered cover crop while a slide, product table, score board, or game UI may need a wider treatment.
- If automatic subject tracking is unavailable, inspect source frames and use deliberate static transforms. Do not leave large empty bars or apply one global crop that hides essential text, products, scores, controls, or demonstrations.
- Add captions, title text, product cards, score labels, supporting media, music, or motion graphics only when they clarify the selected event.
- Preserve exact names, numbers, prices, scores, dates, units, and claims from verified source evidence.
- For music and dance, align cuts to musical phrases or beat structure rather than fixed intervals.

### 8. Verify the composed result

Use one `view_timeline_frames` call on the composed timeline with at most four samples. Cover the opening, the main event or claim, the ending, and any highest-risk overlay or crop change. Verify audio boundaries, subtitle timing, subject visibility, factual consistency, duration, aspect ratio, and export readiness using `qa-and-evaluation.md`.

If an optional enhancement such as subject tracking or automatic caption avoidance fails, preserve the verified cut and continue with a frame-checked static layout. Report the omitted enhancement instead of blocking the deliverable.

After review, automatically materialize every approved Sequence into My Media. Switch to each approved Sequence, call `submit_render_job` with `saveToMediaPool:true` and a filename derived from the Sequence name, then continue queuing the remaining clips without waiting for each render serially. These are background jobs shown in the editor's top-right export queue; the user does not need to run a separate export step. Skip this automatic materialization only when the user explicitly asks for draft Sequences only.

The saved asset records the source Sequence, render job, original source asset IDs, and source ranges; the editable Sequence remains the master. Use `track_export` once after all jobs are queued to report current progress. Do not start duplicate renders for a Sequence that already has an active job.

Report the selected source ranges, profile, main evidence, applied edits, known uncertainty, and verification performed. Do not report a finished clip from tool success alone.

## Output Modes

- **Contiguous highlight:** one continuous source range with cleanup and packaging. Prefer this for authenticity, sports events, music, demonstrations, and sensitive claims.
- **Extractive cutdown:** several source ranges assembled without rewriting the speaker's meaning. Use visible or motivated transitions where continuity changes.
- **Editorial remix:** a new narrative assembled from multiple moments. Use only when the user requests a promotional, recap, montage, or story treatment.

## Rules

- Preserve speaker intent, causality, chronology where material, and the relationship between setup and payoff.
- Treat transcript, OCR, chat, and model descriptions as fallible evidence; resolve important numbers or identities against the source.
- Prefer multi-signal agreement, but retain strong single-modality events such as a silent visual reveal or an instrumental musical peak.
- Adapt detail and pacing to stream pace. Fast events usually need compact context; slow demonstrations and teaching often need more setup.
- Keep candidate decisions explainable through source timestamps and evidence.
- Do not pad the requested count with weak, repetitive, or misleading clips.
