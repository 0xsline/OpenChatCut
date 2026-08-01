---
name: explainer-video
description: Create finished explainer videos from a topic, script, outline, voiceover, product logic, data, technical concept, course material, or reference assets. Use when the user wants narration, motion graphics, stock footage, generated visuals, or mixed visuals to explain an idea.
---

# Explainer Video

Use this workflow to turn information into a clear finished video. The information is the product: topic, script, logic, data, product mechanism, or voiceover. Visuals support understanding. Explainer Video owns the section plan, narration mode, timing order, assembly, and QA; `create-motion-graphics` is the helper workflow for direct Motion Graphic authoring and placement.

## Workflow

1. Read the project state, prompt, attached files, assets, transcript, and timeline.
2. Identify the working labels:
   - `explainer_start`: `topic_only`, `script_or_outline`, `voiceover_or_transcript`, `product_or_data`, `reference_assets`, or `direct_mg_animation_brief`.
   - `source_structure`: `free_topic`, `script_sections`, `timestamped_sections`, `slides_or_pages`, `existing_voiceover`, `uploaded_assets`, `product_or_data`, or `mixed`.
   - `narration_mode`: `generated_tts`, `existing_voiceover`, `transcript_only`, or `none`.
   - `visual_mode`: `motion_graphics`, `stock_or_uploaded_footage`, `generated_video_or_images`, or `mixed`.
3. Respect source structure. If the user provides structured material such as timestamps, numbered sections, slides/pages, scene labels, chapters, bullet outline, product points, transcript ranges, or voiceover sections, use that as the default planning scaffold. Merge, split, reorder, or relabel only when there is a clear production reason; explain the change and get user acceptance before treating it as the plan.
4. Ask only for missing details that change the result: topic or script, target length, audience, platform/aspect ratio, language/voice, visual mode, tone, brand/style constraints, and whether to plan first or create directly.
5. If more than one detail is missing, load `widget-forms` and ask in one `<widget>`. Use text fields for topic/script/context and single-choice fields for duration, platform, language/voice, and visual mode.
6. Complete the preflight before writing visual treatments. The plan must have values for:
   - `source_structure`
   - `narration_mode`
   - `visual_mode`
   - `animation_reference`: `read` or `not_needed`
   - `visual_direction_source`: active Design Style, chosen preset, concrete user style/reference, accepted role anchor, explicit proceed-without-alignment, or `not_needed`
   - `voice_selection`: confirmed concrete preset, audition needed, or `not_needed`
   - `timing_source`: actual voiceover/transcript ranges, generated TTS duration, user timestamps, planned duration, or `not_needed`
7. Animation Reference Gate. If any section may use motion graphics, animation, animated diagrams, data animation, mechanism visualization, abstract concept visualization, or MG overlays, read [references/explainer-animation.md](references/explainer-animation.md) before writing those visual treatments. If the visual plan uses only stock footage, uploaded footage, generated live-action/video clips, or still images, mark `animation_reference: not_needed` and continue without loading it.
8. Motion Graphic Direction Gate. If any section will generate MG/animation, load `create-motion-graphics` before asking the user to choose visual style. Use it to read the existing project visual language, align or confirm the Design Style, and directly author and place the Motion Graphic. Explainer Video still owns narration mode, section order, timing, assembly, and QA. Before final MG authoring, confirm visual direction through one of: active Design Style, catalog Design Style preset chosen from visual cards, concrete user style/reference, accepted role anchor, or explicit proceed-without-alignment. Treat broad hints such as "clean", "modern", "technical", "cinematic", or "tech style" as filters for preset selection, not as enough to generate final MGs. Do not invent text-only style choices before checking presets; assistant-written style options are fallback alignment, not a catalog preset.
9. Build a compact explainer plan only after the relevant gates above are complete:
   - viewer promise or thesis
   - preserved or proposed sections
   - narration source and timing source
   - narration-to-visual map per section: narration text or time range, visual goal, visual treatment, source assets, and sync risk
   - assumptions and claims that need grounding
   - first visible result to create before batching
10. For `topic_only`, write a short outline before drafting or generating. For `script_or_outline`, preserve the user's claims and meaning while tightening structure. For `product_or_data`, explain the mechanism or value without inventing unsupported claims. For `direct_mg_animation_brief`, do not force a broad explainer outline; inspect the provided script, assets, references, transcript, or style target, then create the requested MG section, intro, diagram, or overlay inside the same gates.
11. Voice Gate. For `generated_tts`, load `voice` before recommending voices, choosing a preset, or submitting TTS. If the user has not confirmed a concrete voice preset, follow `voice` to read the curated voice list and show an audition widget first. Do not infer a `voiceId` from the content topic, language, gender, or broad style words.
12. Create or align narration only when needed. For `generated_tts`, draft or tighten section-level narration lines first; estimate whether they fit target timing before submission, rewrite obvious mismatches, generate/place TTS by section only after the Voice Gate is complete, then read actual audio duration before any matching narration-backed MG/animation generation. Do not submit TTS and its matching MG in the same parallel batch. For `existing_voiceover`, do not regenerate narration; transcribe or read the audio and split it into section time ranges before generating matching visuals. For `transcript_only`, confirm whether the transcript should become TTS, captions, or only structure if ambiguous. For `none`, skip narration sync and plan visuals from the information structure and output rhythm.
13. Produce visuals section by section. For MG/animation, verify the animation reference has been read, visual direction is confirmed, and `create-motion-graphics` has been used for direct authoring and placement before final generation or batching. For generated-TTS sections, even the first representative section MG must wait until that section's actual TTS duration is known. For narration-backed MG/animation, duration must come from the matching narration's actual audio duration when available, not from script estimates. For stock, uploaded, generated-video, or mixed visual sections, inspect/select the visual source first and use it only when it supports the section. When style or correctness is uncertain, create the first representative section or shot before batching only after required narration timing exists; a pre-audio style proof requires explicit user approval and must be labeled style-only, not treated as a section MG or placed as final timeline content.

14. Assemble the timeline with narration, visuals, captions when useful, background music, and section pacing. For narration-backed MG/animation sections, align narration and matching visuals to the same start time and cover the full narration section unless the visual plan intentionally changes shots within that section.
15. Run Narration-Visual Sync QA before done. For each narration-backed section, check whether spoken content matches the visual, whether visual duration covers narration, whether visual information density supports the spoken point, and whether transitions happen too early or too late. Fix failures before delivery by tightening narration, splitting the section, extending/regenerating visuals, adjusting timing, or asking the user to choose a tradeoff.
16. Final QA before done: topic clarity, factual grounding, visual-mode fit, narration coverage, timing, caption readability, audio mix, timeline continuity, narration-visual sync, and export readiness.

## Rules

- Explain the idea; do not merely decorate narration with icons or subtitles.
- Do not invent facts, prices, medical claims, performance claims, legal claims, or product guarantees.
- Do not use existing footage as filler when it is unrelated to the explanation.
- Do not average every uploaded asset into the video. Use assets only when they support a beat.
- Do not keep asking after enough information exists to make the first visible result.
- Do not put full spoken sentences on screen. Use labels, numbers, short questions, or section titles.
- Do not rewrite structured user inputs into a different section plan without explaining why and getting user acceptance.
- Do not output MG/animation visual treatments before the animation reference gate has been resolved.
- Do not generate final MG/animation before the visual-direction gate is resolved.
- Do not satisfy the visual-direction gate with ad hoc style choices you invented before loading `create-motion-graphics` and checking its project visual-language intake. A `preset` means a catalog Design Style preset shown through visual cards, not a text label.
- Do not force generated TTS when the user already has a usable voiceover or does not want narration.
- Do not call `submit_voice` before loading `voice` and confirming a concrete voice preset.
- Do not submit a narration-backed MG/animation in parallel with the TTS that should time it.
- Do not submit final narration-backed MG from estimated script duration. Narration-backed MG must use the matching narration text or time range and the real audio duration when available.
- Do not let `create-motion-graphics` override the Explainer Video source structure, narration mode, section order, timing, assembly, or QA workflow.

## Plan Format

Use this compact format when planning:

- `explainer_start`: starting point label
- `source_structure`: input scaffold and whether it is preserved or changed
- `narration_mode`: `generated_tts`, `existing_voiceover`, `transcript_only`, or `none`
- `output`: platform, aspect ratio, target length, language, and voice when relevant
- `viewer_promise`: what the viewer will understand by the end
- `preflight`: animation reference status, visual-direction source, voice selection, and timing source
- `sections`: beat, narration text or time range, visual goal, visual treatment, source assets, sync risk
- `first_visible_result`: the first section or shot to create before batching; mark it as non-final if real narration timing is not known
- `sync_check`: for narration-backed MG, note the timing source, narration duration, MG duration, match result, and any fix applied

When reporting execution, include created timeline names, narration mode, visual modes used, assumptions, sync fixes applied, and what to review first.