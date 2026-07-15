---
name: widget-forms
description: Use when a ChatCut Codex plugin session should ask the user for structured input with an in-chat form, including single-select, multi-select, text fields, visual style cards, voice audition cards, or native ChatCut scenario cards.
---

# Widget Forms In Codex

Use the ChatCut MCP Apps form tool. Do **not** output raw ChatCut native
`<widget>...</widget>` HTML in Codex conversations; Codex cannot render that
editor-only protocol.

## Runtime Rule

Call `ask_followup_questions`. This is the Codex/external-MCP equivalent of the
native ChatCut widget form protocol.

Plan the whole questionnaire before calling the tool. Send one final form, not a
trial form followed by a corrected form. The tool supports at most 12 fields; if
the user asks for more questions, merge related prompts into combined fields
before the first call.

After calling `ask_followup_questions`, stop the turn and wait for the submitted
answer to appear in chat. Do not apply a choice, create assets, or continue
planning from a recommendation until the user's selection is present in the
conversation.

## Supported Field Mapping

Build a `fields` array. Write every visible string in the user's conversation
language.

- Native `<form-single>` -> `{ type: "single", variant: "default" }`
- Native `<form-multi>` -> `{ type: "multi", variant: "default" }`
- Native `<form-text>` / `<form-textarea>` -> `{ type: "text" }`
- Native `<form-visual>` -> `{ type: "single", variant: "visual" }`
- Voice audition cards -> `{ type: "single", variant: "voice" }`
- Native start-scenario cards -> `{ type: "single", variant: "scenario" }`

## Form Copy Tone

For form-level text (`title`, `prompt`, `fields[].label`, `submitLabel`, and
`messagePrefix`), write like ChatCut is a capable video-making partner inviting
the user to describe what they want, not like a rigid survey.

Aim for:

- Warm, open-ended, and action-oriented. The copy should imply "choose the
  closest video need or just tell me your idea; we can figure it out together."
- Short and scannable. Use one natural sentence for `prompt` and concise
  question labels.
- Honest capability framing. ChatCut can help with many video workflows, but do
  not claim unsupported abilities or guarantee a result before inputs are known.
- The user's language and local product terms. Keep "ChatCut", "B-roll",
  "Motion Graphics", "MG 动画", model/product names, and platform names in their
  established forms.
- User-facing creative wording. For early planning or creative-intake forms,
  prefer natural terms such as idea, direction, plan, story, shot list, audience,
  mood, or video need over internal production-document language.

Avoid stiff labels such as "Select video type", "Please choose the video type
for this project", or "What type of video do you want to make?" for scenario
intake unless the host has no room for warmer copy.

For a scenario-intake form, prefer copy like:

```json
{
  "title": "What do you want to make?",
  "prompt": "Choose the closest video scenario, or choose Something else and describe your idea.",
  "submitLabel": "Start creating",
  "messagePrefix": "I want to start with this video direction:",
  "fields": [
    {
      "id": "scenario",
      "label": "Which scenario fits your video best?",
      "type": "single",
      "variant": "scenario",
      "otherPlaceholder": "For example: turn my travel footage into an atmospheric vlog / make a launch video for a new product"
    }
  ]
}
```

Do not include file-upload questions in Codex forms. If a task actually needs
source media and the project/chat does not already have it, ask the user
separately to upload files through the Codex composer Add files flow or directly
in the ChatCut editor. File upload is not a default prerequisite for every
questionnaire; only ask for it when the next editing step depends on missing
media.

For choice fields:

- Use `id` for the internal value the next tool call needs.
- Use `label` for what the user sees.
- For ordinary single-select and multi-select cards (`variant: "default"`), keep
  options label-only. Do not add per-option `description` unless the user cannot
  distinguish the choices from labels alone.
- Use `description` mainly for voice cards. Visual style cards should usually
  use only `preview` + `label`.
- When an off-list answer is acceptable, add an explicit option with
  `id: "__other__"` and a `label` in the same language as the rest of the form,
  using the word the user would expect for an off-list answer. The widget will
  turn this option into a text entry when selected. Use `otherPlaceholder` if
  the text entry needs a placeholder.

For visual cards:

- Use real image URLs or data image URLs in `preview`.
- For Design Style catalog choices, call `manage_design_style` with
  `action: "list_presets"` first, then map each returned preset to
  `{ id: preset.id, label: preset.name, preview: preset.thumbnailUrl }`.
- Never hardcode catalog preset ids unless the user already selected one.

For voice cards:

- Use `audioUrl` for the sample file.
- Prefer the documented sample path such as `/voice-samples/doubao-liuchang.mp3`
  or a public HTTPS URL. Do not pass localhost sample URLs; MCP host iframes do
  not reliably resolve editor-local media.
- Keep user-visible descriptions provider-neutral. Describe the voice the same
  way the native ChatCut audition UI does: gender / age range / tone / use case,
  such as `Female / young / friendly, general` or `男 / 中年 / 低沉知识解说`.
  Do not show provider names like ElevenLabs or Doubao in option descriptions.
- Keep the option `id` equal to the provider voice id needed by `submit_voice`.

For native start-scenario cards:

- Use this when the user should choose which ChatCut video workflow to start,
  such as talking-head editing, MG animation, long-video-to-shorts,
  product/app promo, AI short film, or explainer video.
- Present these as common video needs/scenarios, not as the only possible video
  workflows. The form must also let the user describe a different video need.
- Use exactly one single-select field with `variant: "scenario"`.
- Provide options using the canonical ids below and localized labels in the
  user's language. Include `id: "__other__"` only when you need to customize the
  off-list label; otherwise the backend appends a localized Other option.
- English, Chinese, and Spanish scenario labels/descriptions/starter prompts are
  built in. For any other user language, faithfully translate each scenario's
  English `label`, `description`, and starter prompt into the user's language
  and pass those localized values in the option objects. Preserve ChatCut
  product terms and workflow meaning; do not add new requirements. Use
  `submitPrompt` for the translated starter prompt. This override is specific to
  `variant: "scenario"`; ordinary option cards, voice cards, and visual style
  cards already get their visible text from the values you pass.
- Do not provide custom `preview` or `audioUrl`; the backend fills the native
  first-screen preview image.
- Canonical ids: `talking-head`, `motion-graphics`, `long-video-to-shorts`,
  `app-promo`, `ai-cinematic-short-film`, `explainer`, plus `__other__` for a
  free-form video need.
- Example options:
  `{ "id": "talking-head", "label": "Talking Head Editing" }`,
  `{ "id": "motion-graphics", "label": "Motion Graphics" }`,
  `{ "id": "long-video-to-shorts", "label": "Long Video to Shorts" }`,
  `{ "id": "app-promo", "label": "Product / App Promo" }`,
  `{ "id": "ai-cinematic-short-film", "label": "AI Short Film" }`,
  `{ "id": "explainer", "label": "Explainer Video" }`,
  `{ "id": "__other__", "label": "Something else" }`.

## Current Gaps

`ask_followup_questions` is for structured answers only. It does not support native
custom HTML, timeline parameter bridges, editor item selection, or file upload
fields. For files already held by the agent runtime or attached directly to the
chat outside this card, the media-import workflow is still valid: call
`import_media` and run the helper/direct upload path. For files the user wants
to place directly in a project, ask them to use the ChatCut editor upload UI.

## Example

```json
{
  "title": "Your video idea",
  "prompt": "Choose or fill in what you have in mind so ChatCut can pick a good starting direction.",
  "submitLabel": "Send idea",
  "messagePrefix": "Continue with this video direction:",
  "fields": [
    {
      "id": "goal",
      "label": "What's the main goal of this video?",
      "type": "single",
      "options": [
        { "id": "product_intro", "label": "Product intro" },
        { "id": "social_ad", "label": "Social ad" },
        { "id": "__other__", "label": "Something else" }
      ]
    },
    {
      "id": "elements",
      "label": "What should it include? (Select all that apply)",
      "type": "multi",
      "options": [
        { "id": "broll", "label": "B-roll" },
        { "id": "logo", "label": "Brand logo" },
        { "id": "__other__", "label": "Something else" }
      ]
    }
  ]
}
```
