---
name: talking-head-guide
description: |
  Guide for editing videos where the primary content is people talking — talking-head / 口播, interview / 访谈, lecture, tutorial, podcast, course content, and similar talking-driven formats. Use when the user wants speech editing on a talking video (剪口播 / 口播剪辑 / 去口癖 / clean up fillers / smooth speech), motion graphics layered onto talking video (口播加 MG / 加动画), or B-roll on a talking video (加 B-roll / add B-roll). For motion graphics specifically, use this together with the active Motion Graphics skill/workflow available in the current ChatCut environment — this skill adds talking-specific guidance (speech-rhythm timing, frame-aware placement, subject/caption protection, placement verification).
user-invocable: true
---

# Talking Head Video Editing

## What this skill covers

**Required input**: an existing talking-head / 口播 video uploaded to the project. If the user wants to start without one (e.g., generate a fresh talking-head from scratch), this skill doesn't apply.

**When the user enters this workflow without a source video uploaded yet, ask via a widget surface — bundle the file upload with the treatment selection in one flow**, not two separate turns or a markdown "drag your file in" instruction. Load `widget-forms` for the host-specific route. Never tell the user to "拖进编辑器" / "点击素材库的上传按钮"; that's friction with no upside.

If this workflow is running through a Codex/connector host and the task creates, targets, or opens a ChatCut project for the user, satisfy any returned `browserHandoff.required=true`, `Codex internal Browser handoff`, or equivalent live project handoff before starting nontrivial edits and again before final delivery if the visible editor no longer matches the project.

Independent treatments that can be applied to talking-head videos. Pick the ones that match what the user wants — not all are needed every time.

- **A-roll editing** (中文称 **语音剪辑** / 含 **去口癖、停顿、重复**) — transcript-based speech editing. Common operations include cleanup, highlight extraction, restructure, opening hook, and others as needed for the aligned outcome.
- **Motion graphics overlay** (英文展示给用户时写全称 **Motion Graphics**，不要缩成 "MG"；中文产品术语固定为 **MG 动画**——不要叫"动效""字幕条""动态字幕"等其它说法) — reinforce key information, structured content, and topic transitions with on-screen motion graphics
- **B-roll** (industry term — keep as "B-roll" in any language, do not translate) — cover jump cuts or visualize what's being said
- **Background music** (中文 **背景音乐**) — set mood and smooth micro-gaps
- **Captions** (中文 **字幕**) — on-screen text for accessibility
- **AI Voice Isolation** (中文 **AI 人声隔离**) — clean or isolate spoken human voice with DeepFilterNet3, picture untouched. See the `voice-isolation` skill.

> 用户语言为中文时，在 widget options / choices options / 对话文案里**严格使用上面括号里的产品术语**——别自己再翻译一遍，会跟产品其它地方对不上。

## What shapes the edit

Beyond picking treatments, a talking-head edit is shaped by several orthogonal variables. When the user's ask is vague, these are what's worth clarifying first:

- **Target** — platform (YouTube / TikTok / Shorts / ...), desired length, aspect ratio
- **Which treatments to apply** — the treatments above are optional; don't assume all of them apply
- **Pacing / tone** — tight / energetic / formal / casual; brand or voice preferences if stated. (For MG visual style, follow the active Motion Graphics skill/workflow.)

When more than one of these variables is missing, ask with one form after loading `widget-forms`. Do not ask markdown numbered questions and then append `<choices/>` for only one part of the same intake.

## Order of execution

When multiple treatments have been aligned with the user, they depend on each other and must be finalized in dependency order. This section is **only relevant after alignment** — it doesn't tell you what to start with on a fresh request.

The speech timing (set by A-roll editing) anchors everything downstream — MG placement, B-roll cut-covers, music duration, and caption sync all reference the final speech timeline.

So: finalize A-roll editing before committing any visual, audio, or text layer. Don't write captions against pre-edit speech, don't cut music to pre-edit length, don't place MG against timing that will shift.

**You must confirm the result with the user after each major step before starting the next**, unless the user has explicitly asked to run end-to-end without stopping. Key checkpoints when multiple treatments apply: after A-roll editing finalizes the speech timing; before MG generation (confirm style and direction, and, when it isn't obvious, whether it sits over the video as an overlay or takes the whole frame); after MG generation; same pattern for B-roll, music, and captions. **Don't bundle multiple checkpoints into one response — confirm each step separately.** An upstream mistake forces redoing everything downstream (e.g., MG placed against pre-cleanup timing wastes generation credits when the timeline shifts).

---

## A-roll editing

### Scenario

In a talking-head workflow, the first step is usually A-roll editing: editing the original spoken footage.

A-roll edits are ultimately applied to the timeline and change what the viewer actually hears and sees. However, the editing decisions should usually start from the transcript, because the core question is: what spoken content should the viewer hear, and what should be removed, compressed, or reordered?

### Common A-roll tasks

A-roll editing is not only cleanup. First decide what spoken-content task the user is asking for, then choose the editing strategy and tools.

Common tasks:

- **Cleanup** — remove mistakes, repeated attempts, verbal habits, filler words, and meaningless pauses so the speech becomes clearer and more natural.
- **Highlight extraction** — pull the most valuable, opinionated, emotional, or topic-relevant moments from longer footage.
- **Restructure** — reorder spoken content, such as moving the conclusion earlier, grouping by topic, or combining scattered parts into a clearer structure.
- **Hook / short version** — use a strong claim, result, conflict, or question from the source as the opening, or compress long content into a shorter version.
- **Target-script / script alignment** — match, keep, and reorder spoken content according to a user-provided target script, target paragraph, or desired content.

Cleanup is the most common task and the one most likely to fail from bad boundary decisions. It is described in detail below. Other tasks get shorter rules, but still follow the shared A-roll principles: complete meaning, clear boundaries, and natural listening flow.

### Shared A-roll principles

These principles apply to all A-roll tasks, not only cleanup.

- **Decide the task before choosing the tool.** Do not let tool availability change the editing strategy.
- **Edit by complete semantic units.** Whenever possible, move/delete/keep complete sentences, complete ideas, complete answers, or complete steps. Do not cut out a half-sentence just because a few words match.
- **When the task names what to keep, trim to that boundary.** The inverse of the rule above, for any task that specifies which content to keep — restoring a specific sentence, matching a target script, pulling a named highlight, building a version: keep exactly the requested span. Trim the kept range to start and end at the requested words and drop the off-script head/tail of the source `[sN]` segment it sits in; keeping a whole segment for one requested sentence is over-keeping that drags in unrequested speech. This applies only when the task names what to keep — never to open-ended cleanup, where you keep complete units (above).
- **Do not stitch unfinished fragments across retakes.** Do not combine incomplete pieces from different attempts into one artificial sentence. This does not make the earlier attempt disposable: keep a complete useful lead-in, setup, contrast, category, evaluation, or context if it is not repeated later and can naturally connect to the later complete retake.
- **Preserve connective tissue.** List labels, contrast words, subjects, verbs, and adjacent source words are not filler when removing them makes a kept idea ungrammatical, abrupt, or misleading. Trim the smallest span that keeps the line speakable.
- **Keep listening flow natural.** The result should still have natural phrasing and breathing room. Do not make sentences feel glued together just to make them "clean."
- **Be conservative when boundaries are uncertain.** If unsure whether a cut harms meaning, logic, or listening flow, keep it or make a smaller cut.
- **Confirm complex changes first.** For complex restructuring, aggressive shortening, structural changes, or generated hooks, confirm target length, structure direction, and what to preserve with the user before editing.
- **Explain content, never indices.** You MUST NOT explain edits to the user with internal addresses such as `[sN]`, `[cN]`, `[gap]`, word indices, clip ids, or segment ids. The user cannot see those addresses and will not understand what they mean. Use the actual spoken content, a short quote, or a plain-language description of the edit.
- **Never name a screen position for a panel.** When you invite the user to review or fine-tune the result, call it "the Transcript panel" (中文「文字稿面板」) — never a direction (left / right / side / 左侧 / 右侧). The layout is rearrangeable and the panel does not sit in a fixed corner.

### Cleanup goals and decisions

#### What good cleanup means

Good cleanup does not mean making the video as short as possible, and it does not mean rewriting the speaker into a different script.

Good cleanup means:

- The logic stays coherent
- The expression becomes clearer
- The audio feels natural
- Obvious mistakes, repeated attempts, meaningless stalls, and filler are removed
- The speaker's intent, tone, and natural rhythm are preserved

Bad cleanup usually falls into two failure modes:

- Under-cleaning: obvious mistakes, repetition, long pauses, or filler remain.
- Over-cleaning: sentences are cut off, meaning is missing, rhythm becomes too hard, or the result sounds stitched together.

Default principle: remove defects without changing meaning; make speech smoother, not harder; prefer small local cuts over whole-sentence or whole-segment deletion; when unsure whether a cut harms meaning, keep it.

#### How to judge common cleanup cases

Below are the common cleanup categories and how to make editing decisions for each.

##### Meaningless filler words

Fillers fall into two categories.

The first category is clearly meaningless hesitation sounds. These are usually safe to remove:

- `um`
- `uh`
- `er`
- `ah`
- `呃`
- `额`

When they do not carry special meaning, use `clean_script` first for bulk cleanup.

The second category depends on context and must not be removed by word list alone:

- `so`
- `like`
- `然后`
- `就是`
- `嗯`
- `啊`
- `那个`
- `那`
- `对`
- `所以`
- `但是`

How to decide:

- If the word is only hesitation or padding, remove it.
- If it carries sequence, continuation, contrast, cause, reference, response, emphasis, or natural tone, keep it.
- If removing it makes the surrounding words sound hard-spliced, keep it or only compress the pause.
- If unsure, keep it.

Examples:

- `um, I think this solves the main problem` -> remove `um`.
- `It works like a checklist` -> keep `like`; it is a comparison.
- `The upload failed, so we retried it` -> keep `so`; it carries cause/result.
- `right after the call, send the recap` -> keep `right`; it modifies timing.
- `然后我们再看第二点` -> keep `然后`; it marks sequence.

##### Retakes and repeated attempts

A retake is when the speaker retries the same intended idea because they misspoke, got stuck, forgot words, or restarted. Retake cleanup is not "delete repeated text." The goal is to keep one complete, natural, logically coherent version of the intended idea.

Use this decision path:

1. Decide whether it is really a retake.
   Treat it as a retake only when multiple attempts are trying to say the same intended idea. Do not treat it as a normal retake when the repetition is intentional emphasis, a rhetorical beat, a structural marker, or a second pass that adds new information or tone.
2. Define the complete version to keep.
   A complete version may include more than the main content sentence. It may need a lead-in, connector, section marker, topic setup, contrast, qualifier, subject, object, or conclusion. These are not filler when the kept content depends on them.
3. Cut only the failed or covered part.
   Remove only words that are wrong, dangling, abandoned, or fully covered by the kept version. The cut boundary starts at the repeated or failed idea, not automatically at the earlier transition, setup, or continuous speech. If earlier speech contains useful context that the kept version does not repeat, keep it.
4. Choose the best complete attempt.
   If several attempts are complete, usually prefer the later one because it is often closer to the speaker's intended take. But do not choose the last attempt mechanically. If the later attempt is missing needed context, structure, subject, object, or conclusion, keep the more complete version or preserve the missing lead-in from the earlier attempt.

A repeated lead-in is redundant only when another equivalent lead-in remains naturally connected to the kept content. If removing every copy makes the result lose structure or sound abrupt, keep one natural copy and remove only the extra restarts. Do not stitch unfinished fragments from different attempts into one artificial sentence.

Examples are patterns, not a closed list:

- Local false start inside a kept sentence:
  `There, there's no After Effects, no Premiere, no DaVinci Resolve learning.`
  Keep the complete sentence, but remove the abandoned restart:
  `There's no After Effects, no Premiere, no DaVinci Resolve learning.`
  Do not keep the stray first word just because the full sentence is otherwise useful.
- Repeated structural lead-in:
  `And secondly, ... and secondly, we're introducing a brand new UI.`
  Remove the extra restart, but keep one natural lead-in attached to the kept content:
  `And secondly, we're introducing a brand new UI.`
  Do not delete every structural marker and leave only:
  `We're introducing a brand new UI.`
- Useful setup before a failed ending:
  `Then the next one is different from comedy. It is popular on Disney Plus. It is called...`
  Later retake:
  `It is a popular Disney Plus show called Love Story.`
  Keep useful setup that the later retake does not repeat, and cut from the failure point:
  `Then the next one is different from comedy. It is a popular Disney Plus show called Love Story.`

##### False starts and unfinished fragments

Use `false starts / unfinished fragments` for this category. `False start` is the more natural editing/transcription term for a speaker beginning a phrase and then restarting or abandoning it; `unfinished fragment` makes the dangling half-sentence case explicit.

Only remove a fragment when it clearly does not form useful information.

Safe to remove:

- The speaker abandons the thought and a complete version appears later.
- The segment is only a dangling phrase, such as "this is actually..." with no completion.
- It is clearly the leftover beginning of a failed attempt.

Do not remove:

- A sentence that is imperfect but contains useful information.
- A lead-in that provides the subject, object, or context needed later.
- Content that provides setup, contrast, conclusion, emotion, or tone.

If only part of a sentence or segment is wrong, do not delete the useful content around it. Remove only the bad word, phrase, or pause; if a local cut cannot sound natural, keep the segment.

##### Pauses and breaths

Pause cleanup should default to compression, not zeroing out. Spoken video needs natural breathing room.

Default rules:

- Obvious long pauses over 0.8-1s: usually compress to about 0.3s.
- Between sentences: keep about 0.3-0.5s so listeners can hear natural phrasing.
- Around topic shifts, contrast, or emphasis: keep slightly longer pauses when needed; do not make the delivery too rushed.
- Short breaths inside one sentence: if they are normal breathing, do not remove them.
- Clear long pauses inside one sentence: compress them, but not so tightly that adjacent words sound glued together.
- Long pauses before a retake: if the failed attempts around it are removed, remove the pause with them.
- If the user provides explicit thresholds, follow them. For example, if the user says "only process pauses over 0.8s and keep at least 0.3s", do not process natural pauses under 0.8s.

How to operate on pauses:

- For batch pause cleanup across the timeline or track, use `clean_script`. This is the default path for compressing many long pauses.
- Translate common user wording into `clean_script` pause rules:
  - "Tighter breaths" / "compress pauses" / "compress anything over 0.3s to 0.3s" → `silence: "compress:300"` (or the requested cap).
  - "Restore some breathing room" / "do not make it too rushed" / "keep at least 0.5s" → `silence: "restore:500"` (or the requested minimum).
  - "Make all pauses around 0.5s" → `silence: "normalize:500"`.
  - "Keep pauses between 0.3s and 0.8s" → `silence: "range:300-800"`.
    Any rule that makes a pause longer — `restore`, `normalize`, or the lower bound in `range` — never invents new silence. It only recovers pause time that already existed at that exact spot in the original recording. If the original pause was shorter than the requested value, it stops at the original pause length.
- You do not need to call `read_script({ showSilence: true })` before batch pause cleanup. By default, `timeline.md` hides silence markers, but `clean_script` can still detect and rewrite silences internally.
- Use `read_script({ showSilence: true })` only when you need to inspect or manually adjust a specific pause. Then edit the visible marker: `~~[silence=0.8s]~~` to fully cut it, `[silence=0.8s→0.2s]` to compress it, or leave it untouched to keep it.
- After semantic edits, review the final clean `timeline.md`. If the final pacing still has many long pauses, run `clean_script only="silence"`; if only one or two pauses feel wrong, use `showSilence: true` and adjust those manually.

Script gap primitive note:

- Do not create an accidental `[gap]` on the primary video track as a pacing pause. A Script `[gap]` means no source is playing; on the only visible video track it renders as black. If pacing needs breathing room, preserve or restore source silence with `clean_script` / `[silence=...]`, cover the moment with B-roll/MG/a full-frame visual beat, or intentionally declare the black beat in the plan.

### Other A-roll task guidance

#### Highlight extraction

Highlight extraction is not about making the content as short as possible. It is about selecting the most valuable spoken content according to the user's criteria.

Rules:

- First identify the highlight standard: opinion, conclusion, story, emotion, conflict, tutorial step, data point, or a specific topic.
- Each highlight should be understandable on its own. Do not remove the subject, setup, question, or conclusion needed to understand it.
- Do not keep only a short punchy sentence if the surrounding context is required for it to make sense.
- If the user asks for a specific topic, remove other topics. If the user asks for the "best" or "most exciting" moments, prioritize information density and expression strength.
- After extracting highlights, usually clean up the kept segments so the final result is polished.

#### Restructure

Restructure means changing the order of spoken content. It does not mean freely breaking sentences apart.

Rules:

- First confirm the target structure: chronological, by topic, by question, conclusion-first, tutorial steps, or short-form pacing.
- Move complete semantic units: complete sentences, ideas, answers, or steps.
- Do not split one sentence so the first half appears in one place and the second half elsewhere.
- After moving content, check whether connectors still work, such as "so," "but," "next," or "this."
- If the user asks for major restructuring without specifying the target structure, confirm before editing.

#### Hook / short version

Hook / short version work aims to make the opening more compelling or compress long content into a shorter but still complete version.

Rules:

- Prefer pulling the hook from the original footage: a strong claim, result, conflict, question, counterintuitive statement, or emotionally strong moment.
- If a new hook or new narration must be generated, confirm the direction with the user first.
- For short versions, do not cut only by duration. First identify the main line to preserve: problem, core point, key reasons, and conclusion.
- Short versions can remove examples, repetition, and setup, but must keep the logic needed for the point to hold.
- If the user gives a target duration, try to match it. If duration and semantic completeness conflict, explain the tradeoff.

#### Target-script / script alignment

Target-script / script alignment means cutting the final spoken content according to a user-provided script, target paragraph, or desired content.

Rules:

- The target script is the main constraint: prioritize content that matches the target meaning.
- Natural spoken paraphrases are acceptable, but do not include surrounding content that the target does not ask for.
- If the source has multiple similar versions, choose the most complete, natural, and target-aligned version.
- If target order differs from source order, reorder as needed, but move complete semantic units.
- If the target script omits source context, follow the target. Do not add long surrounding context unless the result would be incomprehensible without it.

#### Building versions, highlights, and excerpts — stay on Script

Highlight, short version, excerpt, hook, restructure, and making several versions are all transcript-content tasks: drive them through Script (`read_script` → edit `timeline.md` → `apply_script`), never by looking up timestamps and placing source clips manually.

- Pick the starting point by where the content comes from. Versions on the current timeline: trim or reorder `timeline.md` and `apply_script`. A version on its own timeline (the user asked for separate timelines, or wants each version independently editable/exportable): `manage_timelines` action=duplicate — the copy carries the content and its script, so you immediately `read_script` → trim → `apply_script` on it. Building fresh from library assets: `manage_timelines` action=create, add the source asset, then drive it through Script.
- To bring in source content the current cut no longer shows (a hook line, a segment needed for another version), read `library/<filename>.md`, copy the needed `[sN]` line(s) into `timeline.md` where they belong, and `apply_script`. This is how you pull source content onto the timeline — through Script.
- For multiple versions on one track: list every version's `[sN]` segments in `timeline.md` in version order, one version after another, then `apply_script` once. Reuse is just repetition — the same `[sN]` segment may appear in more than one version, and repeating the line replays that source range again.
- Never look up timestamps with `find_transcript` and place spoken content with `edit_item` / `split_item`. If you are converting transcript segments into source frame or second ranges, you are off the editing surface — return to Script. `edit_item` / `find_transcript` are only for non-transcript placement such as MG overlays and B-roll visual timing.

**Check each version against its request.** After assembling a version, highlight, or excerpt, re-read the result end to end and confirm every requested sentence is present, in the requested order, with no extra source carried in. Fix any dropped, duplicated, or out-of-order content before finishing.

### A-roll / transcript-based editing workflow

Use this flow for any A-roll task driven by transcript meaning.

1. Start with orientation. Call `read_script`, then read `timeline.md` once to understand the user's goal, the content structure, and whether fixed fillers or long pauses are present. If you will run `clean_script`, do not build the full semantic edit from this pre-clean read.
2. For cleanup tasks, run the mechanical cleanup pass before semantic editing when fixed fillers or long pauses are present. Use `clean_script` for fixed hesitation sounds (`um`, `uh`, `er`, `ah`, `呃`, `额`) and batch pause compression. If both are present, use the default `clean_script` pass so both are handled together. Do not use this step for context-dependent fillers, retakes, repeated sentences, or anything that needs meaning.
3. After `clean_script`, always read the refreshed clean `timeline.md` before semantic editing. Use this refreshed file as the source of truth; `clean_script` changes the canonical timeline and rematerializes the script, so previously read text may be stale. Do not edit from memory based on the pre-clean script. Then edit `timeline.md` with semantic judgment: choose the best retake, clean false starts, remove repeated or failed attempts, preserve useful setup and context, reorder content when needed, and keep the speech natural. For long transcripts, work one clear section at a time if that improves judgment accuracy.
4. Apply the edit with `apply_script`. If apply fails, fix the markdown error or stale state, re-read the current `timeline.md` if needed, and apply again.
5. Review the edited result. After a real `apply_script`, read the regenerated clean `timeline.md` and check what the viewer will actually hear: broken logic, missing context, over-deletion, missed cleanup, wrong order, or pauses that feel too tight or too long. Fix clear problems only. If the final result still needs batch pause adjustment, use `clean_script only="silence"`. Use `read_script({ showSilence: true })` only for manual adjustment of specific pauses.

### What transcript editing actually changes

Editing `timeline.md` is not just changing displayed text. It describes which source media ranges should play on the timeline.

`[sN]` rows are ASR segments, not semantic units. A complete sentence, idea, retake, or transition may span several `[sN]` rows, and one `[sN]` row may contain only part of a sentence. Before deciding what to delete or keep, mentally reconstruct the complete spoken sentence or idea across adjacent rows.

- Each spoken-text line maps to a playable source range.
- Inline `~~...~~` removes the corresponding audible audio range.
- Deleting a whole line removes that whole spoken segment.
- Moving/reordering lines changes playback order.
- `apply_script` applies the result back to the timeline.
- Start/end trims may remain as one trimmed clip.
- Deleting words or pauses in the middle of a sentence splits the original clip into multiple new clips: one kept range before the deletion and one kept range after it.
- Moving spoken content also creates a new clip at the destination.
- More clips after middle deletions or moves are expected and usually correct. Do not describe that as a "fragmentation problem" or as proof that word deletion is unsupported.

### Tool boundaries

Choose the editing goal and content boundaries first, then choose the tool. Do not let tool availability change the editing strategy.

- `clean_script`: use for mechanical first-pass cleanup: bulk removal of fixed meaningless fillers and batch silence compression/adjustment. It can process silence even when `timeline.md` is currently rendered without silence markers. Do not use it for context-dependent fillers, retakes, repeated sentences, or semantic decisions.
- `read_script` + `apply_script`: the main transcript-based editing surface. Use it for real semantic editing: deleting words, sentences, pauses, reordering, or pulling library content onto the timeline.
- `manage_transcript` action `fix`: only fixes ASR mistakes or speaker attribution. It does not cut audio and does not change what the viewer hears.
- Caption SEGMENTATION (分句 / where pages break) is INDEPENDENT of the transcript and controlled by two per-word primitives only: to SPLIT one card into two, set `display_text` `forcePageBreak:true` on the word that should START the new card; to MERGE a card up into the previous one, set `display_text` `keepWithPrevious:true` on that card's FIRST word (works for any break — no box resizing, no wordsPerPage fiddling). To drop a repeated/false-start word, use `display_text` `hidden:true`. Box width / fontSize / `wordsPerPage` are style & density knobs, NOT per-boundary segmentation levers — do not widen the box or raise wordsPerPage to merge or split a specific card. NEVER edit the transcript to fix a caption line break — `manage_transcript fix` is only for an ASR-misheard WORD (content), not layout. `read_captions` shows each page's `break=` reason and per-word keys for these edits.
- `find_transcript`: only locates when a phrase is spoken. It does not edit. If the next step is cutting spoken content, return to Script.
- `Edit` / `Write`: use these to modify `timeline.md`. The edit only reaches the timeline after `apply_script`.

Script details to preserve:

- `read_script` materializes `timeline.md` (current cut) and `library/<filename>.md` (full read-only source transcripts) in the workspace.
- Single-word audible deletion is supported with inline strike syntax, such as `[s1] 过去~~呢~~一个月`.
- Silence markers are hidden by default. Use `clean_script` for batch pause cleanup. Use `read_script({ showSilence: true })` only to expose `[silence=Ns]` markers for precise manual edits such as `~~[silence=0.8s]~~` or `[silence=0.8s→0.2s]`.
- `find_transcript` can locate a phrase for visual timing; it is not the editing surface. Do not use `find_transcript` + `split_item` / `edit_item` to cut, place, or assemble transcript-based clips — this includes highlights, hooks, excerpts, and multi-version cuts. All spoken-content selection, placement, and reuse happens in Script (`read_script` → edit `timeline.md` → `apply_script`).

---

## MG Overlay

### Goal

Motion graphics layered into A-roll reinforce what the speaker is conveying — deepening the audience's impression of the key points and helping them grasp content that's hard to land through speech alone. Complete A-roll editing first; MG timing is based on the post-edit timeline.

This section only adds talking-head timing, frame-composition, subject/caption protection, and review constraints. For visual style alignment, MG creation or authoring, implementation constraints, editable properties, asset sizing, and verification, use the active Motion Graphics skill/workflow available in the current ChatCut environment.

### MG workflow

For talking-head MG work, treat the video as one edited piece, not as isolated graphics.

1. **Understand the video** — read the transcript and representative frames to learn topic, audience / platform, visual tone, and speaker layout.
2. **Set the visual language** — use the active Design Style, the user's style / reference, a clarified direction, or visual presets from the active MG workflow.
3. **Choose useful MG moments** — add MG only where a visual layer improves comprehension, emphasis, orientation, or pacing.
4. **Prepare each moment** — decide the viewer job, content, visual mechanism, speech span, settled frame, read time, form, background, and composition relationship before creating the MG.
5. **Create through the active MG workflow** — pass the talking-head context into the current environment's MG creation/authoring path. Different viewer jobs, information structures, or visual forms should usually become distinct MGs; reuse only intentionally recurring components.
6. **Place, review, confirm, then extend** — check face, captions, readability, size, and composition. After the first real MG is placed in frame, confirm the effect with the user before expanding, unless they explicitly asked you to finish end-to-end.

### Visual identity

Design Style is the video's confirmed visual language. It gives MGs a shared tone, color logic, typography logic, visual density, and motion language. It keeps different MGs in one family without forcing them into the same shape. It does not decide which MGs are useful, when they appear, where they sit, or whether they are transparent / opaque; those remain per-MG editing decisions.

Resolve the visual language before planning MG moments. Use the active MG workflow for the actual style-alignment interaction and implementation details:

- **Active Design Style** — use it unless the user asks to change the overall style. If Project Context names an active Design Style but does not show details, inspect it once with `manage_design_style action="get"` before planning MG moments.
- **Specific user style / reference** — follow it. If it is custom and not yet confirmed for a batch, use a real planned MG as the sample when the user needs to approve the look.
- **Generic or vague direction** — quality words such as clean, premium, modern, professional, polished, or YouTube-style emphasis are goals, not a visual language. Follow the active MG workflow's style-alignment gate: prefer visual preset options, or use one representative MG for confirmation when the direction is textual / custom.
- **No visual direction** — use the active MG workflow to show relevant visual preset options. Talking-head can be used as a catalog filter when available.
- **"Directly do" / "don't ask"** — choose a concrete temporary direction from the transcript and footage, then continue without user style confirmation. Do not create or update a Design Style from this unconfirmed guess.

Picker is a visual Design Style selector. It shows preset thumbnails so the user can choose a visual direction by sight, instead of describing style in words.

1. Call `manage_design_style` with `action: "list_presets"`, `scenario: "talking-head"` when clear, and the user's `locale`. Use the scenario as a catalog filter, then choose reasonable visual options by preset descriptions and the actual video context.
2. Render reasonable returned presets as visual options using the active form/widget route; do not replace thumbnails with text-only style names when visual thumbnails are available.
3. The picker is a turn boundary: after showing it, stop and wait for the user's submitted selection.
4. When the user picks an option, call `manage_design_style` with `action: "apply_preset"` and the selected `presetId`, then inspect the applied Design Style with `action: "get"` before authoring.
5. If the user responds with text instead of picking, treat it as user direction and continue with the custom direction path.

Persist only confirmed visual language:

- **Picked preset** — the user confirmed it by choosing the visual option. Call `manage_design_style action="apply_preset"`.
- **Custom direction** — after the user accepts the sample, treat it as the confirmed direction for the current MG work. If the current environment supports saving project Design Styles and the user accepts it as the shared project style, save/apply it with the agreed style facts.
- **Unconfirmed guess** — do not create or update a Design Style, including when the user said "directly do it".

After applying a preset or confirming a custom direction as the project style, tell the user in one or two natural sentences that this is now the video's visual style, future MGs in this video will follow it by default, and it can be changed or adjusted later.

### Where MG is useful

MG meaningfully helps comprehension or orientation when the content has:

- **Identity / context labels** — speaker name, role, product name, date, source, or a small persistent section label.
- **Key information / quotes** — a core concept, definition, statistic, conclusion, or key sentence worth emphasizing.
- **Structured information** — multiple points, steps, comparisons, rankings, lists, or processes.
- **Chapter / topic markers** — opening titles, section titles, topic transitions, or visual dividers between sections.
- **Abstract concepts** — cause-effect relationships, cycles, systems, frameworks, or other ideas that are hard to follow verbally.

### Repeated Components

One video should usually have one visual language, but not one universal MG shape.

Reuse a Motion Graphic asset only for intentionally recurring instances of the same component: same viewer task, same information structure, same visual form, and content changed through properties. Repeated chapter markers, recurring section labels, or a repeated status badge can share one asset. Different jobs such as an opening title, chapter marker, quote, list, diagram, and CTA should usually be separate assets that share palette, typography, motion tone, spacing, and material treatment.

An accepted first MG proves the visual language works in frame. It is not automatically a template for unrelated MGs.

### Per-MG decisions

For talking-head videos, do not start MG creation from transcript timing alone. Inspect the target frame first: transcript tells you what and when; the frame tells you form, placement, and background.

Before creating the MG, make four linked editor decisions. They prepare the active MG workflow and the later timeline placement.

| Decision               | Question                                                        | Output                                                          |
| ---------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| **Content**            | What idea deserves a visual layer?                              | Message or visual fact expressed by the MG.                     |
| **Timing**             | When should it land with the speech?                            | Timeline start, duration, read time, and internal motion beats. |
| **Form and placement** | What kind of MG is it, and where can it live safely?            | MG form / size, then timeline placement after asset creation.   |
| **Background**         | Is this an overlay on the talking-head shot, or its own moment? | Transparent overlay or opaque / full-screen beat.               |

#### Only for generator workflows that require a brief

Use this subsection only when the active Motion Graphics workflow explicitly asks you to write a generation brief or request for another model or generator, such as Gemini / motion-graphic-gen.

Skip this subsection for Codex direct-authoring workflows. If you are creating or editing JSX yourself with `create_motion_graphic_from_code` / `edit_asset`, do not use `referenceAssetIds`, `:template`, `:style`, role anchors, or Gemini brief language.

For generator workflows, carry the visual language into the tool call. For now, templates are generation references, not direct-apply targets. Template refs from a Design Style are no different from any other template ID. For new MG assets, pass one code reference source: same-role role anchor with `referenceAssetIds: ["<roleAnchorAssetId>:template"]` only when the visual job, structure, and canvas role are the same; otherwise use the matched template ID directly, for example `referenceAssetIds: ["<templateId>:style"]`. If no template matches, write the confirmed Direction in the brief and use any accepted role anchor only for the same role. Template slot counts are not user constraints: if the user asks for more/fewer bars, rows, items, or data points than the template shows, generate a new structure instead of asking them to fit the slots.

When a template or role anchor is passed, keep the Gemini brief focused on content, role / broad form, background, and frame constraints. Let the reference carry detailed style and motion language.

Map the four shared decisions into a generator brief like this:

- **Content** -> `Content` in the brief.
- **Timing** -> timeline start, plus internal `Timing` only when the MG has its own beats. Internal `Timing` values say _when_ each element appears, not _how_ it moves; leave the motion style to Gemini.
- **Form and placement** -> `Size & shape` in the brief, not final canvas placement. Do not write final `left`, `top`, `right`, `bottom`, coordinates, or placement anchors such as "lower-left" / "top-right" into the Gemini brief.
- **Background** -> `Background: transparent` or `Background: opaque`.

#### 1. Content

Choose what the MG expresses, not just what text it repeats. The content may be a speaker identity, distilled quote, key term, statistic, list, comparison, relationship diagram, chapter marker, or another visual representation of the point.

#### 2. Timing

Choose the timeline anchor first. The MG should land with the relevant speech beat or section boundary, not trail after the speaker has already made the point. Use `find_transcript`; pass `includeWordTimestamps: true` when the MG has internal rhythm such as list items appearing one by one or multi-step reveals.

Write internal timing values relative to the MG's own start time. The timeline item start is the absolute video position; internal timing is the MG-internal rhythm after that start. Exit when the point is fully made.

#### 3. Form and placement

Choose the MG form and likely placement region before creating the asset. The active MG workflow creates the graphic; place the finished asset on the video canvas afterward.

Placement principles:

- **Protect the subject and safe zones.** Avoid the speaker's face, head, hair, glasses, mouth, chin, important products or objects, relevant hand gestures, captions/subtitles, and existing on-screen elements.
- **Keep the caption/subtitle area clear.** If captions may appear, bottom overlays must sit above the caption band, not compete with or cover subtitles.
- **Separate overlays from full-screen MGs.** Subject/safe-zone protection applies to overlays on top of A-roll. A full-screen MG is an intentional visual beat that replaces the A-roll for its duration, so it may cover the speaker and background.
- **Keep the composition intentional.** The MG should support the speaker and message. It should not look like a random sticker, compete with the face, or make the frame feel unbalanced.

Common forms and areas:

| Content type                 | Common form                                               | Common area                                                                                                                     |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Identity / context**       | Name tag or small context label                           | Lower-third first; lower-left or lower-right depending on the shot.                                                             |
| **Key information / quotes** | Typographic quote, pull quote, or emphasis treatment      | Lower-center / lower-third; side area if the bottom is crowded; full-screen for a major punchline, conclusion, or pause.        |
| **Structured information**   | List, step stack, comparison layout, or compact diagram   | Left/right side areas or bottom horizontal area; full-screen if the information is too dense for an overlay.                    |
| **Chapter / topic markers**  | Full-frame title, title overlay, or side title panel      | Full-screen for a strong intro or section break; lower-third for a light cue; side panel when one side has obvious open space.  |
| **Abstract concepts**        | Concept visual, relationship map, cycle, framework, chart | Lower-third if light and readable above captions; side area or full-screen if denser.                                           |
| **Tiny auxiliary labels**    | Badge, status label, logo-like mark, section marker       | Top corners can work here only. Do not use top-left/top-right as the default home for primary opening titles or chapter titles. |

Use the MG's intrinsic form constraints, not final canvas placement, when deciding asset shape. Good examples: "lower-third-style name tag", "compact side treatment", "bottom horizontal strip", "full-screen title beat". Do not bake final canvas coordinates into the asset unless the MG is intentionally full-frame.

For familiar forms like speaker name tags, give the form and content without forcing dimensions early. For constrained overlays, describe the intended rough form or usable area. For full-screen MGs, make the form explicit in **Size & shape** and choose `Background: opaque`.

From the target screenshot, include canvas tone only when it affects legibility: for example, `Other context: dark interior scene — keep the design bright/light enough to read clearly.`

#### 4. Background

Choose background from the form:

- Use `Background: transparent` for talking-head overlays: lower-thirds, side treatments, quote treatments, compact diagrams, and other graphics that sit over A-roll. A transparent root may still contain internal semi-transparent or solid panels.
- Use `Background: opaque` when the MG is its own visual surface: full-screen opening titles, strong chapter beats, full-screen information layouts, and full-screen emphasis moments.
- For full-screen opaque MGs, do not add a separate `solid` item underneath as a color matte. The MG owns the frame; change its `bgColor` / `transparentBackground` properties instead. Do not create temporary solid fallbacks; if you encounter an old transparent-MG-plus-solid fallback while replacing it with an opaque generated MG, delete both fallback pieces, not only the old MG.

Default to a transparent overlay unless a full-screen beat is intended — guessing full-screen/opaque silently is what covers the speaker's face or blanks the frame.

#### Place and review

- Place with `edit_item` (adds/updates). Prefer an explicit rectangle once you know the frame: `left/top/width/height` for direct placement, or `right/bottom/width/height` when right/bottom margins are clearer.
  - **`left`** — explicit x position. **`right`** — margin from the canvas right edge. Do not pass both.
  - **`top`** — explicit y position. **`bottom`** — margin from the canvas bottom edge, symmetric with `right`, e.g. `{ right: 80, bottom: 150, width: 500, height: 350 }` for a bottom-right overlay. Caption-safe defaults: `bottom: 162` (landscape 1080p) or `bottom: 576` (portrait 1080×1920). Do not pass both `top` and `bottom`.
- Use a natural-box asset for overlays: the MG asset `width` / `height` should tightly bound the local visible composition, not the project canvas. Place and scale that local asset on the timeline. Use timeline-sized assets only when the visible design intentionally spans the whole frame.
- Asset dimensions from `track_progress` / project state are practical aids for resizing and placement, not the final judge.
- Verify with screenshots. Pass multiple frames in one tool call — settled state appears alongside any transient mid-animation frames. **Compare frames before concluding**: apparent truncation, missing elements, or "broken design" visible in only some of the batch is animation, not a real flaw. If unclear, re-capture more frames around the suspect one before adjusting anything. Judge from the settled frames. For multiple placed MGs, batch their settled frames into a single call.
- Check the full frame: face/head is clear, important objects and gestures are clear, caption zone is clear when relevant, MG is fully visible, MG content is correct, text is legible, no readable text overlaps, and the composition feels balanced and intentional.
- If it fails, first adjust position and size. If position/size cannot make it work, edit the asset or change the design form. Verify each intentionally recurring component on a target frame before expanding it.

---

## B-roll

### Goal

Enrich visual layers and cover jump cuts left by A-roll editing.

### Where B-roll is useful

- **Cover jump cuts** — when A-roll editing leaves visible jump cuts the user wants to hide
- **Visualize specific references** — when the speaker mentions objects or scenes that benefit from showing

B-roll depends on having suitable footage and adds production effort — treat it as an optional enhancement, not a default. Apply only when the user opts in or there's a clear visual problem to solve.

### Sources

Footage can come from three places: clips already in the project library, stock via `search_stock_media` then `push_asset` with the returned import args, or AI generation via the `video-gen` skill (Seedance 2.0, Plus-only). Pick based on the user's need; if unclear, align with the user upfront.

### How to place

Don't cut away in the first or last 3 seconds. For dense jump cuts (<3s apart), use one long cutaway covering multiple. Don't overlap with MG by default.

First decide the B-roll mode:

- **Full-screen cutaway** replaces the talking head for that moment. Use it when the user asks to show the B-roll full screen, cover jump cuts, or the B-roll needs the full frame to be readable.
- **PiP / small-window overlay** keeps the talking head visible. Use it when the user asks for overlay/PiP, the existing edit style clearly uses small-window B-roll, the user says the talking head can remain visible, or the B-roll is a quick supporting visual.

If the user only says "add B-roll" and the mode is not implied by the existing edit, ask once: "Should these be full-screen cutaways or small rounded-corner PiP overlays?"

For **PiP / small-window overlay**:

1. Inspect the target timeline frame first. Compare candidate destination rectangles in the actual shot. Exclude areas that would cover the A-roll's face/head, mouth, important gestures, captions/subtitles, existing overlays, products/logos, or other visible subjects. Among safe candidates, choose a rectangle that can show the B-roll at a useful readable size, preferring the largest blank or low-information area while keeping the composition balanced.
2. Inspect the B-roll source frame(s). Identify the primary subject/action, protected information, and safe-to-lose areas. Any readable text/UI, name/title, logo, brand strip, product edge, card, poster, or document boundary is protected by default unless the user explicitly approves losing that exact information.
3. Place the overlay at a useful size inside the chosen destination rectangle. Keep the B-roll's protected information visible/readable and the A-roll's protected content unobstructed. Do not default to a fixed corner or lower-third position when another candidate has more usable empty area.
4. Set the media item's native `borderRadius` to 24-36 by default unless the requested style is square/sharp. Do not add a mask/effect solely for ordinary rounded PiP corners; use effects only for special shapes or item types that cannot use native `borderRadius`.
5. Screenshot the affected frame before reporting success. If the only non-obstructive PiP would be too small to understand, switch to full-screen cutaway, choose a different source moment/asset, or ask the user to choose the trade-off.

For **full-screen cutaway**:

1. Compare the source aspect ratio with the canvas aspect ratio before choosing fit; do not default to cover without this check. For close aspect ratios, such as portrait source into portrait canvas or landscape into landscape with less than about 30% difference, use a full-canvas `fit:"cover"` first-pass so the B-roll owns the visual beat.
2. For substantially different aspect ratios, such as landscape media in a vertical canvas or vertical media in a landscape canvas, do not place directly with cover. Inspect the source with `view_asset_frames` before choosing fit if you have not already viewed it. Use `read_av_script` to choose representative video moments and the `visual` skill when the protected region is not obvious.
3. Identify whether protected information would be distributed across the area that cover would crop. Any readable text/UI, name/title, logo, brand strip, product edge, card, poster, document boundary, or subject on both sides of the frame is protected by default.
4. After inspection, cover or safe crop is acceptable only if protected information would survive the crop, such as a single centered subject with low-information edges. Low-information contextual media, such as scenery, crowd shots, or other mood/context footage with no specific text or subject that must be preserved, can use cover even with a substantial aspect-ratio difference.
5. If protected information would be lost, such as text/logos near edges, subjects on both sides, or a wide information layout like a fixture table or match poster, use `fit:"contain"` for the foreground and add a deliberate full-screen background such as an opaque MG background/matte that matches the edit or a blurred/enlarged duplicate/background layer. If a cover attempt only trims a compact subject/action that can be recovered without hiding other protected information, try a safer reframe/crop that moves the source protection frame fully into the canvas and closer to the intended center of attention.
6. Apply the fit strategy per source asset, not as a batch default. Even when the user asks for cutaways, do not batch-place multiple images or clips with `fit:"cover"` without checking each source's aspect ratio and protected content first.
7. Screenshot the final frame and compare it with the inspected source frame(s). Verify that the foreground still preserves the source's protected information, not just that the final canvas looks filled.

After editing, read back the exact item ids you changed. An asset appearing in the library is not proof it is on the timeline; `read_project` must show the new/updated B-roll items. If the result involved crop, fit, scale, overlay placement, or a full-screen composition trade-off, verify the affected frame with a screenshot or visual analysis before reporting success, then fix failed source/destination protection or state the unavoidable trade-off. Do not report success if the target items are unchanged.

---

## Multicam (multiple camera angles of the same take)

When the user has **two or more cameras recording the same moment** — cues like "both angles", "the same interview", "multi angles", "alternate angle", "cut to the other angle", "angle switch", 换角度, 两个机位 — switching to another angle means the picture changes but the **audio and lip-sync must stay matched** to the take.

**Do not hand-compute source offsets with `edit_item` to line angles up.** Manual offsets drift wherever the underlying reference angle was cut, and the drift only shows up later as out-of-sync lips. Use the **`multicam_sync`** tool instead: it runs the editor's audio-based alignment engine and repositions each angle clip so its picture matches the reference angle's audio. Pass the angle clips' `itemIds` (the reference plus the follower angle(s)); optionally name the `referenceItemId`.

Key constraint: a **single cutaway clip that spans a cut in the reference angle** can't be aligned as one piece — split it at that cut with `split_item` first, then pass both pieces to `multicam_sync` so each maps to the reference segment beneath it.

`multicam_sync` runs in the user's editor (no backend path): if it reports the editor isn't open, ask the user to open the project, then retry. After it applies, read the project back to confirm the alignment.

---

## Track roles (turn on auto-ducking)

A track's `role` is the single declaration that drives the audio mix. Set it with `edit_track` and the engine derives a seamless duck — followers dip under speech, then rise back in the gaps — without you hand-adjusting any volume. There are only two roles, plus off:

- The talking / interview / lecture track (and any voiceover / narration) is the **anchor**: set its `role` to `anchor`. This is the track everything else ducks under — set it, or nothing ducks.
- Background music, ambient beds, and b-roll audio beds that should sit under speech → the **follower**: set `role: follower` (auto-ducks under every anchor).
- Short sound effects (SFX), stingers, hits, whooshes, clicks, and other editorial accents usually stay out of ducking → leave their track role unset unless the user explicitly wants those accents tucked under speech.
- Anything that should stay out of ducking → leave its `role` unset (none).

A track with no role behaves exactly as today — roles are additive and safe, so you only set them where the content makes the job obvious.

**Read the existing layout first.** Before creating tracks or placing new clips, read the current track names and roles — if a track is already tagged for this content (a `follower` named "Music", an `anchor` named "VO"), put the new clip there and match its role; only make a new track when nothing fits. **Organize before you assign — roles are per-track, so aim for one role per track.** If the same kind of content is scattered across several tracks (e.g. the voice on A1 _and_ A3), consolidate it onto one track _first_: move the clips with `edit_item` (`updates[].trackId`), then delete the emptied track by id with `edit_track`. Then assign the role once. While you're laying tracks out, stack them the way a mixer reads a session — **voice/VO on A1, the top audio lane; music below it** — and give each a short name like "VO" or "Music" so the spoken word stays easy to find. A sensible default, not a rule; follow the user's intent when the layout should differ. Keep deliberate separation, though — two _different_ speakers, clips that overlap in time, or intentional layering each stay on their own track (and each still gets its role). After assigning, read the project back to confirm every track that should anchor/duck does, and that you left the music's base volume alone.

---

## Background Music

### Goal

Set the mood and smooth over micro-gaps in speech.

### Principles

- Set the music track's `role` to `follower` with `edit_track` (and the talking track's `role` to `anchor`). That single pair turns on auto-ducking — the engine dips the music under speech and lifts it back in the gaps.
- Let `edit_track` initialize `audioRouting.duckDepthDb` from the current timeline loudness when it can. Pass `audioRouting.duckDepthDb` yourself only when the user explicitly wants the music louder or softer under speech.
- Keep the BGM clip's base `decibelAdjustment` natural by default. Do not pre-duck music with a large negative clip gain, then also set manual `duckDepthDb`; only do both when the user explicitly asks for a lower overall bed and a stronger / weaker speech duck.
- Do not put short sound effects (SFX) or stingers on follower tracks by default. Place them at their editorial moment and adjust item volume only if they are clearly too loud or too quiet.
- No prominent lyrics
- Fade BGM in/out with `audioFadeIn` / `audioFadeOut` in seconds, usually 1-2 seconds. Do not pass frame counts to these fields.
- Tone matches content

### Fit to duration

Fit BGM to the final video extent after A-roll timing is finalized. The target duration runs from the BGM start to the real content end (video / visual / speech items), excluding the BGM itself so music never extends the render.

- Unless the user specifies a different BGM start, start BGM at frame 0.
- If generated BGM is longer than the target, place one `audio` item at the BGM start, set its duration to the target duration, and add a fade out. Do not let the full music asset run past the last visual item.
- If generated BGM is shorter than the target, do not stretch one audio item past the asset length; it will end in silence. Instead, tile multiple `audio` items until the target is covered.
- Before placing tiled BGM, calculate how many segments are needed to cover the full target duration, accounting for the planned 1-2 second overlaps. Place all segments in one pass so the whole timeline is covered, then trim the final segment to the target end.
- For tiled BGM, use alternating audio tracks (for example A2/A3) so adjacent repeats can overlap by 1-2 seconds. Fade out the earlier segment and fade in the next segment over the overlap.

### How the engine ducks music

Ducking is automatic once the music track's `role` is `follower`: the engine dips the track under audible `anchor` tracks (the speech / voice), and lifts it back to full level in pauses and the outro. This needs both halves — the music track has `role: follower` **and** the talking track has `role: anchor` (see Track roles above). If nothing is set to `anchor`, nothing ducks and the music stays at full level.

Set music to a normal, audible base level where there is no speech. To tune the dip under speech, update the follower track's `audioRouting.duckDepthDb`; otherwise leave it unset and let `edit_track` auto-initialize from timeline loudness when available. Do not solve speech clarity by heavily lowering the clip and also manually deepening the duck. To keep a track out of ducking entirely (for example a stinger that should punch through), leave its `role` unset (none).

---

## Captions

### Goal

Improve accessibility and engagement with on-screen text.

**Captions are transcribed from the source audio — they always match the speaker's language. Translation between languages is not supported.** Don't ask the user what language they want captions in; pick the preset by source audio language + target aspect ratio.

### Presets

Use only built-in `edit_captions` preset names. There is no `youtube` or `vox` caption preset; platform names describe the target video, not a preset name.

| Source audio language | Aspect Ratio   | Recommended Preset |
| --------------------- | -------------- | ------------------ |
| English               | Portrait 9:16  | tiktok or submagic |
| English               | Landscape 16:9 | studio or submagic |
| Chinese               | Any            | netflix            |
