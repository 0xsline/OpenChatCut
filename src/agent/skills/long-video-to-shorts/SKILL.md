---
name: long-video-to-shorts
description: Cut one long podcast, interview, course, livestream, or other source video into social-ready shorts, reels, highlights, or clip timelines from existing project media. Use when the user asks to cut a long video into Shorts, Reels, TikToks, Xiaohongshu posts, best moments, highlights, or multiple clips.
---

# Long Video to Shorts

Use this workflow when one long source video carries the output. Supporting clips may exist, but the short-form story comes from selecting self-contained moments inside the long source.

This is a OpenChatCut-native workflow. Use the current project, assets, transcript, timeline, and OpenChatCut editing tools. Do not depend on external download, transcription, ffmpeg, or auto-crop pipelines unless the user explicitly asks for an external source that is not already in the project.

## Workflow

1. Read the project state before editing. Identify the primary long video, duration, language, speakers, current timeline, transcript readiness, visual descriptions, and aspect ratio.
2. Confirm that one long source carries the output. If the project is mainly multiple raw clips with no dominant long source, switch to the Multi Clips to Reels workflow.
3. Determine only missing constraints that would change the edit: platform, clip count, target duration, audience, style, captions/title text, music, and whether the user wants options or direct creation.
4. If more than one missing constraint remains, ask for them in one `<widget>` after loading `widget-forms`. Use text fields for open-ended fields like topic, spoken language, audience, or goals; use single/multi choice fields for bounded choices like platform, count, duration, captions, or music.
5. Use transcript ranges when available. If transcription is unavailable or unreliable, inspect visual/audio content and ask only for missing context that changes selection.
6. Scan for moments that can stand alone: clear setup, hook, claim, proof, emotional turn, lesson, conflict, demonstration, or payoff. Read [references/short-form-selection.md](references/short-form-selection.md) when scoring or comparing candidates.
7. Build a compact candidate plan before heavy editing. For each output include source range, opening hook, why it stands alone, payoff, target duration, platform treatment, and risks.
8. If the user gave enough constraints and asked to create directly, proceed after stating the plan. If the source is very long, the request is vague, or the requested count is high, create or preview the first strongest clip before batching the rest.
9. Cut on clean word, phrase, action, or beat boundaries. Tighten filler, false starts, repeated attempts, and dead time only when meaning and tone stay intact.
10. Package for the target platform: aspect ratio/crop, title text, styled captions, music, light motion graphics, zooms, speed changes, or transitions only when they support the selected moment.
11. QA before reporting done: hook in first seconds, clear payoff, standalone clarity, no misleading title, clean boundaries, platform fit, requested count/duration, timeline names, and export readiness.

## Plan Format

When presenting a plan, use this compact shape:

- Clip number/title
- Source range
- Opening hook
- Why it stands alone
- Payoff or viewer value
- Target duration/platform treatment
- Edit notes and risks

When creating clips, report timeline names, durations, packaging applied, assumptions, and what to review first.

## Rules

- Preserve claims, speaker intent, context, and causality. Do not make the speaker appear to say something they did not mean.
- Prefer the smallest range that preserves setup, meaning, and payoff.
- Do not summarize the whole long source evenly.
- Do not choose a quotable line if it needs missing context to make sense.
- Do not use misleading title text to compensate for a weak moment.
- Do not pad with weak clips just to hit the requested count.
- Do not treat a full talking-head polish request as Long Video to Shorts unless the user asks for shorts, clips, highlights, or cutdowns.
- Do not batch many shorts blindly. If the style is not established, create or preview the first strong clip before repeating it.