---
name: storyboard-shot-breakdown
description: Break down each shot and turn the analysis into a storyboard reference. Use when the user wants shot-by-shot film analysis, director logic, cinematography breakdown, or a storyboard-style reference from a video.
---

# Storyboard Shot Breakdown

Use this skill to analyze a video shot by shot and produce a storyboard-style reference that explains the director's visual decisions.

## Core Philosophy

Do not merely describe what is visible. Deduce why each visual choice was made.

Analyze each shot across five director-decision dimensions:

| Dimension          | Core question                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Composition        | What is the viewer forced to look at? What pressure does space, symmetry, depth, or framing create?          |
| Focal length       | What psychological distance does the lens create? Does it compress, expand, isolate, or invade?              |
| Movement           | Why does the camera move or stay still at this exact moment? What changes before and after?                  |
| Cut                | Why cut here instead of earlier or later? Is the driver emotion, story, rhythm, eye trace, action, or sound? |
| Narrative function | What new information does this shot deliver: setup, turning point, emphasis, concealment, revelation?        |

## Workflow

1. Read project state and source media.
2. Read transcript or audio context when available so narrative interpretation is grounded.
3. Detect or mark shot boundaries with available OpenChatCut/media tooling.
4. Extract representative frames for each shot in batch when possible.
5. Inspect frames before writing analysis. Do not invent details that are not visible.
6. For high shot counts, tell the user the count and offer output scope choices before spending effort.
7. Analyze each selected shot using the five dimensions.
8. Summarize the overall visual rule of the scene in 1-2 concise sentences.
9. Generate a storyboard reference image or structured analysis artifact if the user wants a visual output.

## Internal Reasoning

Use a counterfactual test: if the conventional alternative were used, what emotion or information would be lost? The answer is usually the director's motive.

Use this reasoning to improve the analysis, but do not output the counterfactual test as a separate section unless the user asks.

## Output Format

Per shot:

```text
S{N} - {scale} · {lens/mood} · {movement} · {timecode} · {duration} · {narrative function}

Composition: [what attention is forced onto and what pressure the frame creates]
Focal Length: [psychological distance and dramatic effect]
Movement: [why it moves or stays still, and what changes]
Cut: [why the cut lands here, including rhythm/eye trace/sound when relevant]
Narrative: [what story information this shot adds]
```

Overall:

```text
Director's Logic: [3-5 sentences summarizing the visual strategy]
Visual Rule: [1-2 sentences the user can reuse as a shooting/editing reference]
```

## Rules

- Write from visible evidence and available transcript/audio context.
- Do not borrow details from adjacent shots unless clearly stated as sequence-level analysis.
- Keep shot numbering stable.
- User owns scope trade-offs: if output must be reduced, propose choices.
- Prefer current OpenChatCut/media tools over hardcoded local commands. Use external scripts only when they are available and clearly help.