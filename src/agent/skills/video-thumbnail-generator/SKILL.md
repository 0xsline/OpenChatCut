---
name: video-thumbnail-generator
description: Create platform-ready thumbnails from real video frames. Use when the user wants a thumbnail, cover image, YouTube cover, Shorts cover, Bilibili cover, Xiaohongshu cover, or other video poster image.
---

# Video Thumbnail Generator

Use this skill to create a high-clarity thumbnail or cover image from the actual video content.

## Non-Negotiables

1. Use the real video as visual evidence.
   - If the thumbnail shows a person, product, UI, frame, or scene from the video, extract or inspect real frames.
   - Never invent a generic software interface, fake product screen, or unrelated person.

2. Read style references before recommending styles.
   - Use `references/thumbnail-styles.md` and `references/thumbnail-style-recipes.md`.
   - Only offer style directions supported by those references or by the user's explicit instruction.

3. Keep text short and readable.
   - Usually 2-5 words.
   - Avoid thin type, low contrast, small labels, and clutter.

## Workflow

1. Confirm platform and aspect ratio if missing.
   - YouTube / Bilibili: usually 16:9.
   - Shorts / TikTok / Douyin: usually 9:16.
   - Xiaohongshu / WeChat Channels: usually 3:4.
   - Correct ambiguous ratio language gently, especially 4:3 vs 3:4.
2. Read project state, transcript, and available media context.
3. Inspect candidate frames:
   - expressive face
   - product or UI clearly visible
   - dramatic action moment
   - clean composition
   - strong lighting or clear subject separation
4. Classify the thumbnail job:
   - talking-head / opinion / tutorial
   - product / software / demo
   - cinematic / documentary / art
   - entertainment / challenge / reaction
   - education / business / concept
5. Propose concise title text options.
6. Offer 3-6 clearly different style directions.
   - Each option should name the composition, not only a channel/style label.
   - Exclude weak options.
   - Wait for user choice when the direction is not obvious.
7. Generate thumbnail options using selected real frames and the selected style.
8. Check mobile readability, subject fidelity, product/UI truthfulness, and visual contrast.
9. Present results and offer targeted adjustments.

## Prompt Shape

```text
[Platform] thumbnail, [aspect ratio / dimensions], [style name].

COMPOSITION: [subject position, scale, background, graphic balance]
REAL REFERENCE: [describe selected frame zone by zone]
TEXT: "[short title]" in [high-contrast style]
STYLE: [one-line style recipe from references]
CONSTRAINTS: readable at mobile size, no fake UI, no watermark, no play button.
```

## References

- `references/thumbnail-styles.md`: style library from real thumbnail analysis.
- `references/thumbnail-style-recipes.md`: quick style recipes and prompt patterns.
- `references/field-testing-notes.md`: known failure modes.