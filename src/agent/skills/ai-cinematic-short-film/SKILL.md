---
name: ai-cinematic-short-film
description: Plan AI short films with story, shots, prompts, and continuity.
---

# AI Cinematic Short Film

Use this workflow when the user wants OpenChatCut to create a cinematic AI-generated short film or story-led visual sequence.

This is a OpenChatCut-native workflow. If a source workflow depends on external image/video generation or manual assembly, replace that step with OpenChatCut's equivalent capability when available. Do not add unrelated OpenChatCut features just because they exist.

## When to Use

- The user starts from an idea, product, script, reference image, mood, or story premise.
- The work needs shot planning, prompt craft, visual continuity, and cinematic pacing.
- The user wants AI-generated clips assembled into a finished short.

## Workflow

1. Define the creative brief: premise, emotion, audience, platform, aspect ratio, duration, and ending.
2. Create a compact story structure: hook image, setup, escalation, reveal or payoff, final beat.
3. Build a style bible using [references/cinematic-ai-workflow.md](references/cinematic-ai-workflow.md): world, character, color, lens/camera language, motion, lighting, and continuity rules.
4. Draft a shot list. Each shot should have a purpose, duration, visual action, camera move, prompt notes, and continuity note.
5. Use existing or generated reference frames only when continuity would otherwise break, especially for characters, products, locations, or costumes.
6. Write prompts per shot with subject, action, environment, camera, lighting, mood, and negative constraints. Keep prompts specific but not brittle.
7. Generate clips, review continuity, and regenerate only shots that break story clarity or visual consistency.
8. Assemble the selected shots in the timeline. Add audio or text only when the brief or source workflow explicitly calls for it.
9. Final QA: story clarity, shot order, continuity, visual artifacts, and export readiness.

## Rules

- Story clarity beats visual novelty. Do not overproduce beautiful shots that do not serve the film.
- Keep a shared style bible so shots feel like one film.
- Do not silently change characters, products, claims, or key user references.
- Ask for confirmation when the premise, ending, product representation, or visual identity is ambiguous enough to change the result.
- Replace external generation or assembly steps with equivalent OpenChatCut capabilities when they exist. Do not introduce unrelated OpenChatCut features just because they are available.

## Output

When planning, show a concise brief and shot list. When executing, report generated clips, timeline structure, and any shots that need user review.