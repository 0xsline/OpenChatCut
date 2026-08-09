---
name: voice
description: |
  Text-to-Speech (TTS), voiceover, narration placement/sync, and custom sound effects (SFX) generator. Use when the user wants generated speech from text, wants to add/replace/align narration or voiceover for an existing video/timeline, wants to keep existing voiceover synced after visual retiming edits, needs voice audition/selection, or explicitly wants a newly generated/custom sound effect that is not available in the Sound Effects library.
user-invocable: true
---

# Voice & Sound Effects Generator

Generate voiceovers (TTS) and sound effects. For TTS, choose a concrete
provider and voice before calling `submit_voice`.

## When to Use

- Generate voiceover/narration from text
- Create text-to-speech audio for videos
- Add, replace, or redo narration/voiceover for an existing video, timeline,
  screen recording, slide animation, product demo, B-roll edit, MG explainer, or
  other visual sequence
- Keep existing narration/voiceover aligned after trimming, speeding up, slowing
  down, moving, reordering, or replacing the visuals it describes
- Offer and audition TTS voice choices when the user has not picked a concrete voice
- Generate custom sound effects from text descriptions only after checking the Sound Effects library first

## TTS (Text-to-Speech)

If the current request has an existing visual target and the user wants
narration, voiceover, dubbing, or replacement speech for that target, read
[references/video-sync.md](references/video-sync.md) before drafting new
narration, using existing narration text to generate TTS, or placing audio. Do
this even when the user did not explicitly say "sync" or "match the visuals";
the existence of a visual target means narration timing and meaning may need to
follow on-screen content. Use the normal standalone TTS path only when there is
no visual target or the user just wants an audio asset from text.

Also read [references/video-sync.md](references/video-sync.md) when the timeline
already has narration/voiceover and the user asks to change the visuals while
keeping that voiceover aligned. This is a sync maintenance task even if no new
TTS is needed.

Use `submit_voice` to create a TTS audio asset. The current MCP tool contract is:

- `provider` is required. Configured choices may be `doubao`, `elevenlabs`,
  `minimax`, `inworld`, `fishaudio`, `speechify`, `openai`, `gemini`,
  `mistral`, or `cartesia`. All providers are opt-in; use only providers shown
  as configured in the capabilities prompt.
- `voiceId` is required, concrete, and provider-specific. The only exception is
  deliberate MiniMax `timbreWeights` mixing, where `voiceId` must be empty. Do
  not mix catalogs.
- The curated catalog in [references/voices.md](references/voices.md) covers
  only Doubao, ElevenLabs, and MiniMax. Other providers have no bundled preset
  or sample catalog in OpenChatCut. Require a concrete voice ID from the user or
  their provider account; never invent a preset or `/voice-samples/...` URL.
- AI SDK-backed fields are provider-specific: OpenAI supports `modelId`,
  `speed`, `outputFormat`, and `instructions`; Gemini supports `modelId`,
  `outputFormat`, and `instructions`; Mistral supports `modelId` and
  `outputFormat`; Cartesia supports `modelId`, `speed`, `languageCode`, and
  `outputFormat`. Omit unsupported or unrequested fields.
- Inworld, Fish Audio, and Speechify accept only `voiceId` plus optional
  `modelId`. Do not pass expressive, speed, language, or output controls to
  these providers.
- `submit_voice` creates an audio asset only. Timeline placement, replacement,
  trimming, and alignment happen later with timeline tools.
- For long narration, multiple `submit_voice` calls can be useful: split at
  natural pauses, sentence groups, or script beat boundaries when the workflow
  benefits from separately timed or placed voice clips.
- Doubao supports `speedRatio`, `loudnessRatio`, `pitch`, `emotion`,
  `emotionScale`, `performancePrompt`, and `explicitDialect`, but not every
  voice supports every expressive control. Check
  [references/voices.md](references/voices.md) before using them.
- ElevenLabs retains its official voice settings, language, seed, output,
  normalization, pronunciation-dictionary, continuity, logging, and latency
  controls. MiniMax retains its dedicated controls documented in
  [references/minimax-tts.md](references/minimax-tts.md).

Doubao control support for current curated voices:

- `vivi`, `xiaohe`, `yunzhou`, `xiaotian`, `naiqimengwa`, `yingtaowanzi`,
  `wenroumama`, `zhixingnv`, `dayi`, `jitangnv`, `liuchang`, `ruyayichen`,
  `morgan`, `qingcang`, `huiben`, `popo`, `yuanboxiaoshu`, `baqiqingshu`, and
  `tangseng` support explicit `emotion` / `emotionScale`,
  `performancePrompt`, and ASMR-style prompt directions.
- `shuanglangshaonian` supports `performancePrompt` and COT/QA-style
  instruction following, but does not support explicit `emotion` /
  `emotionScale` or ASMR-style control.
- `explicitDialect` is only supported by `vivi` and can be `dongbei`,
  `shaanxi`, or `sichuan`.

ElevenLabs control support for current curated voices:

- `amelia`, `brittney`, `hope`, `jessica`, `arabella`, `jane`, `maria`,
  `mark`, `frederick`, `peter`, `james`, `jon`, `sully`, `david`, and `alex`
  all support the same request-level controls; model-specific support is still
  validated by ElevenLabs.
- These controls are not per-voice guarantees of a specific acting style.
  Use the preset tags/samples to pick a naturally suitable voice, then use the
  controls for moderate delivery changes.
- For ElevenLabs `eleven_v3`, inline audio tags are available when the user
  asks for expressive delivery such as emotion, tone, nonverbal cues, accent
  hints, or local pacing. Official examples fit these useful TTS categories:
  emotion/tone tags such as `[happy]`, `[sad]`, `[angry]`, `[excited]`,
  `[curious]`, `[sarcastic]`, `[crying]`, `[annoyed]`, `[appalled]`,
  `[thoughtful]`, `[surprised]`, and `[mischievously]`; vocal delivery and
  nonverbal cue tags such as `[whispers]`, `[laughs]`, `[sighs]`, `[exhales]`,
  `[inhales deeply]`, `[clears throat]`, `[snorts]`, `[swallows]`,
  `[wheezing]`, and `[coughs]`;
  pacing/pause/local speed tags such as `[slowly]`, `[pause]`,
  `[short pause]`, `[long pause]`, `[rushed]`, and `[drawn out]`; and
  accent/special-performance tags such as
  `[strong X accent]`, for example `[strong French accent]`, plus `[sings]`,
  `[singing]`, `[woo]`, and `[pirate voice]`. Official examples are
  non-exhaustive; similar auditory tags can be tried when the user explicitly
  asks for that delivery and the tag describes how the voice should sound, not
  a visual action. Write tags directly in `text`, close to the short phrase
  they should affect. Treat tags as local guidance, not paragraph-wide controls.
- For pauses and pacing in `eleven_v3`, use punctuation, text structure,
  shorter generated segments, or local audio tags such as `[short pause]` and
  `[slowly]` when needed.

```ts
// English / multilingual via ElevenLabs
submit_voice({
  provider: "elevenlabs",
  text: "Hello world",
  voiceId: "peter",
});

// Chinese via Doubao
submit_voice({
  provider: "doubao",
  text: "你好世界",
  voiceId: "liuchang",
});

// With speed adjustment (Doubao only)
submit_voice({
  provider: "doubao",
  text: "这是一段稍快的中文旁白。",
  voiceId: "liuchang",
  speedRatio: 1.5,
});

// With expressive Doubao controls
submit_voice({
  provider: "doubao",
  text: "这次事故提醒我们，安全永远不能侥幸。",
  voiceId: "liuchang",
  emotion: "sad",
  emotionScale: 3,
  performancePrompt: "痛心但克制，语速稍慢，像新闻专题旁白",
  pitch: -1,
  speedRatio: 0.92,
});

// With ElevenLabs delivery controls
submit_voice({
  provider: "elevenlabs",
  text: "The launch changed how teams plan their daily work.",
  voiceId: "peter",
  speed: 0.95,
  stability: 0.4,
  similarityBoost: 0.8,
  outputFormat: "wav_44100",
});

// MiniMax TTS (when configured) — see references/minimax-tts.md
submit_voice({
  provider: "minimax",
  text: "欢迎使用视频编辑助手。",
  voiceId: "female-yujie",
  speed: 1,
  name: "VO · welcome",
});

// Cartesia shape after the user confirms the exact account voice ID.
// confirmedCartesiaVoiceId represents that supplied value, not a preset.
submit_voice({
  provider: "cartesia",
  text: "A concise product introduction.",
  voiceId: confirmedCartesiaVoiceId,
  modelId: "sonic-3",
  speed: 1,
  languageCode: "en",
  outputFormat: "mp3",
});
```

## Voice Audition Before Generation

When the user needs TTS and has not already chosen a concrete voice, first
separate providers with curated OpenChatCut choices from providers that require
an account-specific voice ID.

For Doubao, ElevenLabs, or MiniMax, read
[references/voices.md](references/voices.md) before recommending, rendering, or
submitting an option. Use it as the only source for curated preset IDs,
provider choice, display labels, tags, and bundled sample URLs. Do not create
voice options from memory, translated names, or broad user descriptions.

For Inworld, Fish Audio, Speechify, OpenAI, Gemini, Mistral, or Cartesia, do not
offer an invented audition list or sample URL. Ask the user for the concrete
voice ID from that configured provider. A broad description such as "warm
female" is not a valid `voiceId`.

First determine two separate languages:

- User conversation language: the language the user used to talk to you. Use
  this for the surrounding reply, `form-visual label`, `visual-option name`,
  and `summary`.
- Target narration language: the language of the text being synthesized. Use
  this only to choose provider and voice catalog.

The audition widget's submit button is fixed to the default label in this build
(`submitLabel` is accepted but not rendered); keep the question label and option
labels in the user conversation language, not the target narration language. For example:
English users see `submit_label="Submit"`, Chinese users see
`submit_label="提交"`, and Spanish users see `submit_label="Enviar"`.

"help me generate ... voice over in Chinese" is an English conversation asking
for Chinese narration, so the audition widget copy stays in English while the
voice candidates come from Doubao.

For a curated provider:

1. Filter `references/voices.md` by target narration language / provider and
   explicit requirements such as gender, age range, tone, and use case.
2. If no preset matches all explicit requirements, say there is no exact match
   and offer the closest supported presets with a clear caveat.
3. Pick 2-4 matching curated presets.
4. Load `widget-forms`, then call `ask_followup_questions` with voice options
   and real bundled audio samples.
5. Wait for the user to choose.
6. Call `submit_voice` with the selected preset ID as `voiceId`.

For a provider without a curated OpenChatCut catalog, ask for a free-text,
concrete provider voice ID instead. Do not add `media` or synthesize a
`/voice-samples/...` path. Wait for the user to supply/confirm the exact ID
before calling `submit_voice`.

For each curated audition option, keep `value`, display label, `media`, and
`summary` tied to the same preset row from `references/voices.md`. Use only the
sample URLs recorded there. Keep `value` as the preset ID and `media` as its
matching sample URL. Write `name` and `summary` in the user's conversation
language. The target narration language only decides the provider/voice
catalog. After submission, map the display name back to the preset ID from the
same candidate list.

English request for Chinese narration:

```html
<widget submit_label="Submit">
  <form-visual
    id="voiceId"
    label="For Chinese voiceover, I recommend a few voices to try:"
    required="true"
  >
    <visual-option
      value="vivi"
      name="Vivi"
      media="/voice-samples/doubao-vivi.mp3"
      aspect-ratio="16:5"
      summary="Female / young / friendly, general"
    />
    <visual-option
      value="xiaohe"
      name="Xiaohe"
      media="/voice-samples/doubao-xiaohe.mp3"
      aspect-ratio="16:5"
      summary="Female / young / soft, clear"
    />
    <visual-option
      value="yunzhou"
      name="Yunzhou"
      media="/voice-samples/doubao-yunzhou.mp3"
      aspect-ratio="16:5"
      summary="Male / young / neutral, business"
    />
  </form-visual>
</widget>
```

Chinese request for Chinese narration:

```html
<widget submit_label="提交">
  <form-visual
    id="voiceId"
    label="我推荐这几个中文旁白音色，先试听一下："
    required="true"
  >
    <visual-option
      value="morgan"
      name="Morgan"
      media="/voice-samples/doubao-morgan.mp3"
      aspect-ratio="16:5"
      summary="男 / 中年 / 低沉知识解说"
    />
    <visual-option
      value="zhixingnv"
      name="知性女声"
      media="/voice-samples/doubao-zhixingnv.mp3"
      aspect-ratio="16:5"
      summary="女 / 中年 / 冷静知识讲解"
    />
    <visual-option
      value="vivi"
      name="Vivi"
      media="/voice-samples/doubao-vivi.mp3"
      aspect-ratio="16:5"
      summary="女 / 年轻 / 亲切通用口播"
    />
  </form-visual>
</widget>
```

## Sound Effects

For ordinary editing sound effects (SFX), do **not** generate first. Use the
built-in Sound Effects library before generating:

1. Call `browse_library` with `category:"sound-effects"` and a query such as
   `"whoosh"`, `"camera shutter"`, `"notification"`, `"censor beep"`, or
   `"record scratch"`.
2. Inspect the returned `library:sound:<id>`.
3. Place it with `edit_item`, using `fromFrame` as the sound's
   anchor/editorial moment frame:

```ts
browse_library({
  category: "sound-effects",
  query: "short whoosh transition",
});

edit_item({
  adds: [
    {
      type: "audio",
      assetId: "library:sound:whoosh-short",
      fromFrame: 120,
      trackId: "A1",
    },
  ],
});
```

Only generate sound effects from text descriptions with `submit_sound` when:

- The user explicitly asks for a generated/original/custom sound.
- The requested sound is too specific for the existing Sound Effects library.
- `browse_library({ category:"sound-effects", query })` returns no suitable
  match.

```ts
// Custom/generated sound effect after the library has no suitable match
submit_sound({ prompt: "A dog barking in the distance" });

// With custom duration (0.5-22 seconds)
submit_sound({
  prompt: "Thunder and heavy rain",
  durationSeconds: 15,
});

// High prompt adherence
submit_sound({
  prompt: "Sci-fi laser gun firing",
  promptInfluence: 0.8,
});
```

**Tips for better results:**

- Be specific: "A dog barking loudly" vs just "dog"
- Include context: "Footsteps on wooden floor in an empty room"
- Specify style: "Cinematic whoosh" or "8-bit game sound"

## Parameters

### TTS

| Field | Description | Notes |
| --- | --- | --- |
| `provider` | `doubao`, `elevenlabs`, `minimax`, `inworld`, `fishaudio`, `speechify`, `openai`, `gemini`, `mistral`, or `cartesia` | Required; configured choices only |
| `text` | Text to synthesize | Required |
| `voiceId` | Concrete provider-specific voice ID | Required except MiniMax timbre mix |
| `modelId` | Provider model override | ElevenLabs, Inworld, Fish Audio, Speechify, OpenAI, Gemini, Mistral, Cartesia |
| `speed` | Speech speed | ElevenLabs, MiniMax, OpenAI, Cartesia |
| `languageCode` | Language hint/code | ElevenLabs, Cartesia |
| `outputFormat` | Provider-supported output format | ElevenLabs, OpenAI, Gemini, Mistral, Cartesia |
| `instructions` | Natural-language delivery direction | OpenAI, Gemini |
| `speedRatio` | Speech speed | Doubao only |
| `name` | Media-pool asset name | Optional |

### Sound Effects

| Field             | Description       | Notes          |
| ----------------- | ----------------- | -------------- |
| `prompt`          | Sound description | Required       |
| `durationSeconds` | Duration          | 0.5-22 seconds |
| `promptInfluence` | Prompt adherence  | 0-1            |
| `name`            | Asset name        | Optional       |

## Voices

Use the `submit_voice` `voiceId` guide and
[references/voices.md](references/voices.md) for the current curated preset
list, display labels, tags, and sample URLs.

### Voice IDs are provider-specific — do NOT mix them

The curated catalog contains separate Doubao, ElevenLabs, and MiniMax IDs.
`vivi` / `dayi` are only Doubao; `mark` / `amelia` / `james` are only
ElevenLabs; `female-yujie` is only MiniMax. Inworld, Fish Audio, Speechify,
OpenAI, Gemini, Mistral, and Cartesia require a concrete provider-specific ID
confirmed by the user and have no bundled OpenChatCut samples.

Provider choice:

- Honor an explicit configured provider first.
- For Chinese narration, prefer a matching curated Doubao voice (or MiniMax
  when configured/requested). Use another provider only after the user chooses
  it and confirms its voice ID.
- For English / multilingual narration, prefer a curated ElevenLabs voice.
  Use another provider only after the user chooses it and confirms its voice ID.
- Never offer a provider that is not shown as configured in capabilities.

## Hard rules — what you must NOT do

1. Never use a voice ID from a different provider.
2. Never submit TTS while the voice is only described broadly; require a
   concrete provider-specific ID confirmed by the user.
3. Never recommend or render a curated TTS option before checking
   [references/voices.md](references/voices.md).
4. Never invent presets or sample URLs for Inworld, Fish Audio, Speechify,
   OpenAI, Gemini, Mistral, or Cartesia.
5. Never pass provider-specific fields to a provider that does not support them.
6. Never claim stable age, regional accent, pronunciation dictionary, or exact
   duration controls unless the selected provider exposes them.
7. Never replace original recorded speech with TTS unless the user asks.
