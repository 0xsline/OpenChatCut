---
name: create-motion-graphics
description: "Use whenever ChatCut Codex needs to add, create, hand-author, patch, or place Motion Graphic JSX assets in a ChatCut project. This is the Codex direct-authoring path: use create_motion_graphic_from_code / edit_asset / edit_item, not motion-graphic-gen or submit_motion_graphic. Covers project/timeline intake, project visual language, editable properties, asset binding, inline JSX authoring, existing asset updates, timeline placement, and verification."
---

# Create Motion Graphics

Use this skill when a ChatCut task requires a Motion Graphic asset that Codex will author or patch as inline JSX.

This skill is for Codex direct authoring. Do not translate the request into a Gemini prompt or generation brief, and do not call `submit_motion_graphic`, when this workflow is active.

If the current Codex MCP tool list or connector text still exposes `submit_motion_graphic`, treat it as stale/generic surface leakage. Ignore that path for MG work; use `create_motion_graphic_from_code` for new JSX assets and `edit_asset` for existing MG JSX. If the direct-authoring tools are missing, stop and report that the ChatCut tool surface is out of date.

This is a Codex-plugin-specific workflow. ChatCut tools run on the hosted backend, so pass source inline through the available MCP tool path. Do not stage Motion Graphic code in the ChatCut repository, `ai-working/`, `/tmp`, a local HTTP server, generated code files, or guessed backend workspace paths.

## Core Principles

- Inspect project state when canvas size, fps, existing visual language, placement, or timeline conflicts are not already known.
- Identify the required inputs in **Before You Code** before authoring JSX.
- Create or update Motion Graphic assets through the available inline-code asset workflow; use current tool schemas for exact payload shapes.
- Place or move assets through the timeline editing workflow when the edit requires timeline placement.
- Re-read project state and verify the visible frame after structural or visual changes.

## Before You Code

Before writing JSX, identify only the information needed for this edit:

- **Placement**: start time, duration, target layer if known, and the target frame the graphic must compose with.
- **Role in the edit**: what job this Motion Graphic performs in the video.
- **Content**: exact text, numbers, media, or visual facts that must appear.
- **Timing**: whether internal motion should sync to speech, music, or a visual event.
- **Visual source**: user-provided style, project Design Style, brand colors/fonts, or an accepted existing Motion Graphic.
- **Editable fields**: which text, colors, numbers, booleans, image, or video values should become properties.

Ask only for missing high-leverage inputs that would materially change the result.

## Align With The User

You are the junior designer; the user is the manager. Direction is the high-leverage choice — surfacing it before authoring is much cheaper than reauthoring after.

Style alignment gate:

Separate visual direction from batch permission. A user-named text/custom style can choose the direction, but it does not permit multiple MGs until the user has confirmed a representative MG. Batch authoring is permitted only by an active Design Style, a selected visual preset, or a previously accepted representative MG.

- If there is no active Design Style and the user has not named a style, stop before authoring and ask the user to choose a direction.
- Generic quality adjectives are goals, not a named visual style. If the user only says the MGs should feel clean, premium, modern, professional, polished, or similar, use visual preset thumbnails instead of inventing a direction.
- Prefer catalog Design Style presets: call `manage_design_style` with `action: "list_presets"`, present 3-6 reasonable visual choices, and let the user pick or override.
- In Codex, load the `widget-forms` skill and use `ask_followup_questions` with visual thumbnails when preset thumbnails are available; fall back to numbered Markdown only when the visual route is unavailable.
- You may recommend one choice, but still show the choice set. The point is visual alignment, not a single best guess.
- When it isn't obvious, also ask whether the MG sits over the video as an overlay or takes the whole frame.

Before authoring, choose the branch:

- One MG: use the active Design Style, accepted example, or user-named direction and proceed.
- Multiple MGs with an active Design Style, selected visual preset, or previously accepted representative MG: proceed with a batch design map.
- Multiple MGs with only a textual/custom direction, however clear: create exactly one representative MG, place it, render its composed frame, then stop for confirmation. Do not create a second MG asset or item before the user confirms.
- Multiple MGs with only generic quality adjectives: use the visual preset picker first.

When the task needs visual style alignment, check the active project Design Style first. If there is no active Design Style and the user has not given a clear style direction, use the style alignment gate above.

Saved user design styles are a library, not project confirmation. If `manage_design_style list` shows saved styles but no active project Design Style, do not infer or choose one silently; use `list_presets` and visual alignment unless the user selects a saved style or asks you to use one.

Catalog Design Style presets are available as visual style options with image previews. When no active Design Style or user style is set, first look at the available catalog candidates with `list_presets` and show 3-6 reasonable visual starting points. They do not need to match every detail of the user's request; preset thumbnails set useful visual expectations and can be adapted in authoring. Prefer visual options over text-only choices because seeing the look is usually clearer than naming it. Do not force catalog presets when none are reasonably close; use text directions only then.

When using catalog presets, call `manage_design_style` with `action: "list_presets"`; pass `scenario` only when it is clear. Pick 6 matches using each preset's `description` as agent-facing matching guidance when there are enough reasonable matches; use fewer only when fewer presets genuinely fit. Never render the full catalog as user-facing choices. In Codex, use `ask_followup_questions` with one visual single-select field, mapping each preset to `{id, label: name, preview: thumbnailUrl}`; if visual thumbnails are unavailable, render concise numbered choices instead. Do not invent `value`, `name`, or `media` for catalog choices, and do not mix custom non-preset directions into the same visual picker. If a custom direction would help, describe it in prose outside the picker. Do not repeat catalog descriptions under the picker unless the user asks for details. Frame catalog options as visual starting points, not required choices: briefly make clear in the user's language that they can pick a close option or describe a different direction. If the user asks to refresh, call `list_presets` again and show a different set of up to 6 reasonable matches. Do not repeat presets already shown in the current style-picking exchange; show fewer than 6 rather than repeat. Apply the user's pick with `action: "apply_preset"`. After applying a preset or saved style, call `manage_design_style` with `action: "get"` before authoring MG code; preset names and `list_presets` descriptions are picker guidance, not the full motion/design spec. Do not create or update a Design Style from an unconfirmed recommendation.

The visual style picker is a turn boundary. After calling `ask_followup_questions` for style alignment, stop and wait for the user's submitted selection. Do not apply a preset, create MG assets, inspect more frames, or continue detailed MG planning from your own recommendation in the same turn.

For a batch of related MGs in one scene or topic, ask once for a shared direction — don't invent a different aesthetic per item, and don't ask per MG.

When the batch direction is textual or custom rather than a visual preset or active Design Style, the representative-MG gate above is a hard stop. A user-named text style skips only the preset picker; it does not confirm the visual language for multiple MGs. The representative MG validates visual language only; it does not define the form for every later MG.

The only times to skip the style picker:

- The user has already named a visual style, material, reference, or visual language ("做 editorial 杂志风的", "做个 80s 复古印刷", "magazine style 那种") — use it verbatim as the direction. For multiple MGs, this still enters the representative-MG branch until the user confirms the example.
- The user has explicitly waved off alignment ("直接做" / "don't ask, just do it"): make your best guess, name it in chat, then continue with the normal authoring, frame-inspection, and consistency workflow.

## Project Visual Language

Use the active project Design Style, user-provided style, brand assets, or an accepted existing Motion Graphic as the visual language for hand-authored JSX. A visual language means shared palette, typography logic, motion tone, spacing, density, material treatment, and level of polish.

When a Design Style is active, work from its full `designSpec` / `styleGuide`, not only its name or catalog summary. Treat explicit style rules for motion, typography, color, and material as implementation constraints.

Treat Design Style structure, materials, and template notes as visual vocabulary, not default containers. Express the style through typography, marks, geometry, texture, motion, spacing, and materials; use a bounded reading surface only when bounded reading is the actual editorial mechanism.

Do not create or update a project Design Style just because a one-off Motion Graphic needs styling. For multiple Motion Graphics in the same video, keep one coherent visual system unless the user asks for a deliberate contrast, and let each MG's content and editorial job determine its form.

## Visual System And Placement

Treat multiple MGs in the same video as one visual system. Shared style comes from palette, typography, motion tone, spacing, material, and polish.

Before authoring a batch, make a compact design map for the planned MGs: viewer job, content, visual mechanism, how it carries meaning beyond text, speech span, settled frame, read time, size, composition relationship, internal motion beats, and whether its form is intentionally recurring.

Let each MG's content and editorial job determine its form. Keep the same visual language while choosing the composition, size, placement, duration, and rhythm that fit that moment.

Choose the visual mechanism before writing JSX. Decide how the graphic carries meaning beyond text, using the confirmed visual language and the content's viewer job. Name a wrapper as the form only when a bounded reading surface is truly the right mechanism.

Text should rarely carry the whole graphic alone. Pair key words, stats, or claims with a tangible non-text visual role so the result is not just copy inside a wrapper.

Common defaults must earn their place. Use a bounded reading surface only when bounded reading is the editorial mechanism; otherwise let the MG's form come from the frame relationship and viewer job.

Reuse an MG asset only for an intentionally recurring component with the same viewer task, information structure, and visual form. Shared palette, typography, motion, or a bounded-surface treatment is visual language, not a reason to reuse the same asset.

Placement and duration are part of the settled frame composition. Choose each MG's position, size, anchor, start, and end from the relationship between the speech span, inspected frame, reading time, and visual job. Do not use a fixed safe-zone as the default placement; repeated anchors are intentional only when the frame relationship and viewer task recur. If the graphic does not feel integrated with the moment it explains, change its form, timing, scale, or skip.

Match the MG asset duration to the timeline span it is designed to occupy. Internal motion beats must complete inside the placed item duration; when the edit timing changes materially, update or recreate the MG instead of relying on a shorter timeline item to truncate a longer asset.

In a batch, compare the composed settled frames side by side. The MGs should share a visual language, but repeated surfaces, anchors, or rhythms should point to a recurring viewer job; otherwise revise the form, placement, or timing before reporting done.

Create the asset shape that fits the job at hand. For overlays, the asset box should tightly bound the visible graphic's local composition. Use timeline dimensions only when visible design intentionally spans the whole frame.

## Editable Properties

Expose user-visible and likely-to-change values as editable properties.

- Visible text, primary colors, accent colors, and key numeric values should be properties.
- Font choices should be `font` properties when users may reasonably change them.
- Image and video sources must be `image` / `video` properties.
- Code keys must match the property schema keys exactly.
- Read values from `item.props`; do not hardcode visible content that the user may reasonably want to change later.
- Use item-level property overrides only for intentionally recurring components with the same viewer task, information structure, and visual form. If any of those differ, create another MG asset and share palette, type, and motion logic instead.

Property entries should declare a stable key, user-facing label, type, and default value. Supported property types include text, number, color, boolean, select, font, image, and video.

## Fonts

Motion Graphics must use fonts the cloud renderer can load. Do not rely on local/system fonts such as `STKaiti`, `PingFang SC`, `Microsoft YaHei`, `Arial`, `Helvetica`, `Comic Sans MS`, `system-ui`, `-apple-system`, or generic CSS families as the primary rendered font; preview may have them locally, but export will fall back to the default stack.

When choosing or replacing a font, call `search_fonts` and use the returned canonical family name verbatim as the `fontFamily` value and matching `font` property `defaultValue`. Use Google Fonts or project custom fonts returned by the catalog. If a user explicitly asks for an unsupported local font, explain that cloud export cannot preserve it, search for a supported alternative with a similar feel, and use that supported family unless the user explicitly accepts export fallback.

## Assets

Images and videos rendered inside Motion Graphics must already be registered as project assets or otherwise be passed through editable asset properties.

- Do not hardcode media URLs in JSX.
- Use `<Img>` and `<Video>` only with URLs read from `item.props`.
- Guard empty image/video properties before rendering; an empty `src` can crash the runtime.
- To swap a rendered asset for one timeline instance, update that instance's editable property values rather than changing the shared asset code.

## Design Principles

Codex is the designer for direct-authored Motion Graphics. Do not merely satisfy constraints or place text in a wrapper. Before writing JSX, design the settled frame as a specific visual object.

Before writing code, decide:

- **Purpose**: what the viewer should understand faster because this MG exists.
- **Direction**: the specific visual language, not "clean", "modern", or "professional" alone.
- **Memory**: the one visual idea, spatial move, or motion beat the viewer should remember after 3 seconds.
- **Mechanism**: how typography, geometry, diagram, texture, image, or motion carries meaning beyond text.
- **Craft**: how typography, color, motion, spatial composition, and material treatment follow the chosen direction.

Before writing code, choose a clear aesthetic direction for this specific design. Commit to one direction and execute it with precision rather than defaulting to a generic look.

Default quality bar: distinctive, production-grade, and intentional. When the user has not specified a style and asks you to proceed, choose a specific visual direction with a point of view. Do not fall back to safe, basic, or generic just because the style is unspecified.

Restrained does not mean plain. Minimal or refined MGs still need a named design language, precise hierarchy, and one memorable visual decision.

Treat the Design Style's motion language as a constraint, not just mood. If it says hard cut, no opacity, no translate, no glow, no easing, word-by-word, static bars, or sequential nodes, implement those literally; do not replace them with fades, springs, sweeps, glows, or drifting motion.

Motion must earn its place. Do not add shine, sheen, light-sweep, scan-line, shimmer, glow, or glossy passes as default polish; use them only when the style or editorial job explicitly means scanning, loading, reflection, energy, or detection. Prefer typography, masks, stagger, data bars, and timing tied to the content.

Material treatment belongs to the visual language. Do not add glass, blur, heavy shadows, gradients, grain, paper texture, glow, or other surface polish just to make the surface feel designed; use those materials only when the confirmed style or visual job calls for them.

When the graphic includes text, create clear hierarchy. Use the Design Style's type system when it exists. When no type system is defined, make size, weight, spacing, and timing contrast visible at video scale.

Design the most visible frame first, then animate into that layout. Choreograph by importance: the first moving element is the hierarchy leader. Vary direction, duration, easing feel, and stagger rhythm when the visual job changes.

Anti-slop rules are a floor, not a ceiling. Avoid generic AI-generated aesthetics: purple/blue gradient backgrounds, fake glassmorphism everywhere, predictable feature-tile layouts, or cookie-cutter design that lacks context-specific character. Within one visual system, vary form, composition, and rhythm when the visual job changes; keep color and typography logic coherent enough that the MGs belong together.

Do not default to card-shaped overlays. Unless a bounded reading surface is truly needed, avoid floating panels, tickets, notes, or rounded rectangles that simply hold text; they often feel detached from the footage and make the video look like UI rather than motion design.

Use strong materials, texture, gradients, glow, depth, dense composition, or bold motion when they are part of the confirmed visual language or the editorial job. Do not avoid expressive design just because a generic version of the same effect would be bad.

Do not default to centered, symmetrical layouts. Consider asymmetry, overlap, generous negative space, or controlled density, whichever fits the content. Unexpected spatial choices make motion graphics feel designed, not generated.

A character, illustration, or compound shape is one visual entity. When multiple parts must visually connect, attach, or align, render those parts inside a single `<svg>` with one shared coordinate space and named anchors. Independent hardcoded `left` / `top` across separate wrappers produces visible gaps.

### Text Layout Safety

For text-bearing MGs, design the settled frame as a real layout before animating. Use flexbox or grid, `gap`, `padding`, `maxWidth`, `lineHeight`, and natural wrapping for related text blocks. Do not stack readable text with independent hardcoded `top` values unless the text is intentionally decorative or typographic art.

Editable text may become longer than the default. Reserve space for plausible longer copy, allow wrapping with `whiteSpace: "normal"` and `overflowWrap: "break-word"`, and reduce hierarchy, size, density, or change form when the content cannot fit cleanly.

Animated transforms do not affect layout. If text scales, pulses, slides, or staggers near other text, leave visual headroom for the largest animated state. Intentional overlap may be used for graphic layers, shadows, marks, or decorative typography; ordinary readable text must not collide.

Avoid forced `<br>` or manual line breaks for dynamic text unless each line is deliberately fixed. Prefer width-constrained wrapping.

Use this base component shape:

```javascript
const Component = ({ item }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();

  const props = item.props || {};
  const accentColor = props.accentColor;

  const rootStyle = {
    position: "absolute",
    inset: 0,
    backgroundColor: "transparent",
  };

  return <div style={rootStyle}>{/* content */}</div>;
};
```

## Motion Graphic Code Contract

Violations cause runtime crashes. Strict compliance required.

1. **Syntax:** Pure JavaScript JSX. No TypeScript.
2. **Imports:** No import statements. Globals are pre-injected: `React`, `spring`, `useCurrentFrame`, `useVideoConfig`, `interpolate`, `interpolateColors`, `Math`, `random`, `Easing`, `AbsoluteFill`, `Sequence`, `Series`, `Img`, `Video`, and `Audio`.
3. **No Remotion global:** Never use `Remotion.xxx` or `const { ... } = Remotion`. Hooks and components are pre-injected as standalone globals.
4. **Exports:** No `export default`. Define `const Component = ...`.
5. **Timing:** No `Sequence` wrappers inside the component. Use flat frame-driven logic.
6. **Logic:** No inline logic in JSX props. Pre-compute values in variables before `return`.
7. **Helpers:** No undefined functions. Use `interpolateColors` plural. Define any helpers locally.
8. **AbsoluteFill:** `AbsoluteFill` is a component, not a style object. Never spread it. It may be used for inner layers, but never as the root.
9. **Root element:** The root must be `<div style={rootStyle}>`.
10. **Assets:** `<Img>` and `<Video>` sources must read from image/video editable props. Never hardcode URLs. If no assets are provided, design with shapes, text, and CSS.
11. **Hooks:** Get frame from `useCurrentFrame()`, not from `useVideoConfig()`.
12. **Local box:** Component must accept `({ item })` props. The asset `width`/`height` are the MG's natural box around its visible local composition, not the timeline canvas; fill that box with `position:absolute; inset:0`. Timeline placement sets final screen size and position.
13. **Layout control:** Use flexbox or grid for text blocks and structured content. Use SVG or absolute geometry when the design depends on spatial relationships, compound shapes, frame treatments, or drawn/animated marks. Allow text to wrap naturally unless the request requires single-line text.
14. **Editable props:** Component must read editable values from `item.props`. Never add fallback values like `|| "Default"` or `?? false` after `props.key`; declared runtime properties already have values.
15. **Property schema:** Declare matching editable properties. Include all visible text content and primary/accent colors.
16. **Image/video props:** Guard empty URLs; only render `<Img>` or `<Video>` when the URL is truthy.
17. **Background:** Default background is transparent. If a background surface is added, expose a `transparentBackground` boolean property.

## Placement And Review

Do not author JSX from timing alone. Inspect the target frame first: timing tells you when; the frame tells you form, placement, and background. For a batch of overlays, make one target-frame screenshot/contact sheet and decide each MG's settled frame, speech span, read time, and placement relationship before choosing final anchors, sizes, and durations.

Design the settled frame first: choose the moment when the MG is most readable, place the final layout there, then animate into that composition.

Before authoring JSX, make four linked editor decisions. They prepare the Motion Graphic asset and the later timeline placement.

| Decision               | Question                                                               | Output                                                           |
| ---------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Content**            | What idea deserves a visual layer?                                     | The message or visual fact the MG expresses.                     |
| **Timing**             | When should it land and leave?                                         | Speech span, read time, duration, and any internal motion beats. |
| **Form and placement** | What kind of MG is it, and where does it belong in the composed frame? | MG form/size, then `edit_item` placement after asset creation.   |
| **Background**         | Is this an overlay on the footage, or its own moment?                  | Transparent or opaque background.                                |

Placement principles:

- Compose the footage and MG together from the frame you inspected: subject, camera framing, visual weight, captions/subtitles when present, and the MG's job.
- Place the MG where it makes the frame read best for that moment.
- Keep necessary information readable at video scale without zooming; if the MG feels detached, change form, timing, scale, or skip.
- Account for captions only when captions are present or planned.
- Treat full-frame MGs as intentional beats, not as a workaround for awkward overlay placement.

Default to a transparent overlay unless a full-frame beat is intended. A transparent overlay still uses a natural-box asset; do not use a transparent timeline-sized asset just for placement.

Place and review:

- Place with `edit_item` (adds/updates). Prefer an explicit rectangle once you know the frame: one horizontal anchor, one vertical anchor, width, and height.
- Verify with screenshots. Pass multiple frames in one tool call — settled state appears alongside any transient mid-animation frames. Compare frames before concluding: apparent truncation, missing elements, or "broken design" visible in only some of the batch is animation, not a real flaw. If unclear, re-capture more frames around the suspect one before adjusting anything. Judge from the settled frames.
- Check the full frame: necessary information is clear at video scale, captions remain readable when present, MG content is correct, text is legible, and the composition feels balanced and intentional.
- For text-heavy MGs, inspect the settled frame where the most text is visible. Check for text-on-text overlap, clipped lines, overflow outside the natural asset box, and readable content covered by animated scale or translate states.
- If it fails, first adjust position and size. If position/size cannot make it work, change the design form. Verify each recurring component form on a target frame before expanding it.

## Asset And Timeline Flow

### Create A New Asset

Create new Motion Graphic assets by passing inline JSX and editable property metadata through the current ChatCut asset-creation tool. Use the tool schema for the exact field names and accepted duration format.

Choose the MG's natural box, duration, asset name, description, and property schema from the edit requirements. The asset duration should match the intended placed span, including internal entrance, hold, and exit timing. The asset creation step only creates the asset; timeline placement is separate.

For `create_motion_graphic_from_code`, pass that natural box as `width`/`height`; use timeline dimensions only for intentional full-frame MGs. If the content occupies only part of the screen, place and scale the bounded asset with `edit_item` instead of baking screen coordinates into a full-canvas MG.

### Patch An Existing Asset

Before patching, inspect the existing asset code and property schema. Preserve unrelated behavior, property keys, and timeline timing unless the requested change requires otherwise.

Read [`references/canvas-pipeline-rules.md`](references/canvas-pipeline-rules.md) before changing code, especially when SVG is involved. Patch with full inline replacement source through the current asset-update tool.

### Place On The Timeline

Use the timeline editing workflow for placement, movement, trimming, and per-instance property overrides. Dry-run large or uncertain transactions when the tool surface supports validation.

## Implementation Rules

Read [`references/canvas-pipeline-rules.md`](references/canvas-pipeline-rules.md) before any asset-code update, when writing or modifying SVG, or when preview looks correct but export renders black or empty.

## Verification

A successful tool call is not verification.

- Re-read asset state after asset creation or update.
- Re-read timeline state after placement, movement, trimming, or property overrides.
- For visible changes, inspect a real composed frame using the normal ChatCut visual verification path.
- For a batch, compare the composed settled frames side by side; verify that each visual job has a fitting form, repeated surfaces/anchors/rhythms are intentional, and each placement works for its own target frame.
- If the result is wrong, classify the failure before retrying: invalid tool shape, invalid JSX, missing/incorrect property key, timeline placement, async asset readiness, or canvas/export safety.
- Fix placement with timeline edits; fix bad rendering with JSX/property changes; use canvas rules for preview-good/export-black failures.
