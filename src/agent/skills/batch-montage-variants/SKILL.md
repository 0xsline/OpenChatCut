---
name: batch-montage-variants
description: |
  Turn one pool of existing project media into a batch of distinct, publishable montage cuts instead of a single hero edit.
  Use for batch montage, one-source-many-outputs, 一源多出, 批量混剪, 批量出片, 矩阵号, 多账号分发, variant batches, deduped cuts, 去重变体, 防搬运, or when the user asks for N different versions of the same footage.
---

# Batch Montage Variants

Use this workflow when the user wants **many** finished cuts from the same media pool — matrix accounts, A/B hook testing, platform variants, or daily batch output. Each output must satisfy the agreed mode: structural differentiation, a controlled hook test, or a platform adaptation.

This is a OpenChatCut-native workflow. Use the current project, source assets, asset-frame inspection, AV/script context, and OpenChatCut editing tools. Do not depend on external download, transcription, ffmpeg, or auto-crop pipelines unless the user explicitly asks for an external source that is not already in the project.

## When to switch workflows

- One hero edit from many clips → **Multi Clips to Reels**. Do not use this skill to make a single cut.
- One long source defining a story → **Long Video to Shorts**.
- N distinct outputs from a shared pool → this skill.

Tell the user when you switch, and say why.

## Workflow

1. Read the project state before editing. Inventory the source pool: clip count, usable duration, aspect ratio, visual subjects, motion/energy, audio quality, and duplicates.
2. Confirm the user wants more than one output and the pool supports the selected mode. Do not pad a distinct-cut batch with near-duplicates; controlled tests and platform adaptations may intentionally reuse an edit.
3. Fix the batch contract before cutting — mode (distinct cuts, controlled hook test, or platform adaptations), count, target duration, platform, audience, language, and music bed. If more than one is missing, ask in one `<widget>` after loading `widget-forms`.
4. Score every source asset for reuse headroom before planning. See [references/variation-matrix.md](references/variation-matrix.md). Reserve distinct hooks where the mode requires them; shared end cards and intentional shared bodies are allowed.
5. Build the **variation matrix** before editing. For distinct cuts, plan different hooks and structural changes. For controlled hook tests, change only the hook and keep the body fixed. For platform adaptations, retain the approved content and adapt presentation. See [references/variation-matrix.md](references/variation-matrix.md).
6. Plan the dedup budget with [references/dedup-rules.md](references/dedup-rules.md). Decide up front which dimensions carry the differentiation, and record the minimum separation each pair of cuts must clear.
7. Get the matrix approved before cutting the whole batch. Show the plan as a table: cut number, hook, order signature, rhythm, duration, packaging, and the dimension that makes it different from every other cut in the batch.
8. Cut the first variant end to end and verify it renders and exports before batching the rest. Do not generate eight timelines that share one unverified mistake.
9. Cut remaining variants from the approved matrix. Reuse picks and trims according to the approved mode; distinct cuts and hook tests need different openings, while platform adaptations may share them.
10. Name timelines so the batch is auditable: `<topic>-v<NN>-<hook-label>`, consistent across the batch.
11. QA each cut individually **and** the batch as a set. See [references/dedup-rules.md](references/dedup-rules.md) for the pairwise checks.
12. Report per-cut timeline names, durations, the differentiation dimension for each, and which pair is the most similar — that is the pair the user should review first.

## Plan Format

Present the batch as one table, not prose:

| # | Hook asset | Order signature | Rhythm | Duration | Packaging | Differs by |
|---|---|---|---|---|---|---|
| v01 | clip_07 (product in hand) | A-C-E-B | fast-cut, 1.2s avg | 28s | bold captions + beat cuts | hook + order |
| v02 | clip_12 (before/after) | C-A-B-E | slow open, ramp | 34s | minimal captions + zoom | hook + rhythm |

- Total outputs, platform, shared vs distinct music bed
- Source pool size and reuse headroom
- Dedup budget and minimum separation
- Risks: thin pool, single-use assets, near-duplicate pairs

## Rules

- Distinct cuts and hook tests need different opening three seconds. Platform adaptations may share an opening and must be labeled as adaptations, not distinct edits.
- For distinct cuts, differentiate on **structure** before decoration. Styling changes alone do not establish structural differentiation; these checks do not guarantee a platform's duplicate-detection outcome.
- Do not pad a thin pool into N cuts. Report the honest maximum and ask.
- Distinct cuts and hook tests need different hooks; platform adaptations may reuse the same approved hook.
- Keep one variable dominant per cut. When everything differs slightly, nothing reads as different.
- Batch output is not permission to lower the bar: each cut must stand alone as publishable.
- Do not use captions or titles to invent claims the footage does not support, in any variant.
- Report the most-similar pair explicitly. Hiding it defeats the point of the batch.
