# Voice Presets

This page is the curated preset snapshot the agent works from. The backend
holds the source of truth and keeps this file in sync.

Use tags as selection filters. Use descriptions as practical hints. Age,
accent, pronunciation, and exact duration are not stable controls unless the
TTS provider exposes explicit parameters for them.

## Doubao Chinese Voices

Use Doubao for Chinese-optimized narration.

| Preset               | Official display | English display      | Tags                                                           | Selection hint                                                |
| -------------------- | ---------------- | -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| `vivi`               | Vivi             | Vivi                 | female, young, friendly, general, short-explainer              | Everyday Chinese narration, product intros, short explainers  |
| `xiaohe`             | 小何             | Xiaohe               | female, young, soft, calm, tutorial, walkthrough               | Calm tutorials, product walkthroughs, instructional narration |
| `yunzhou`            | 云舟             | Yunzhou              | male, young, neutral, business, explainer                      | Business explainers, factual reads, product narration         |
| `xiaotian`           | 小天             | Xiaotian             | male, young, bright, upbeat, casual                            | Casual creator-style videos and light social narration        |
| `naiqimengwa`        | 奶气萌娃         | Childlike Boy        | male, child, cute, storybook, character                        | Cute boy character lines and children's stories               |
| `yingtaowanzi`       | 樱桃丸子         | Cherry Voice         | female, child, cartoon, roleplay, character                    | Animated/kid-oriented character dialogue                      |
| `wenroumama`         | 温柔妈妈         | Warm Mom             | female, middle-aged, warm, family, gentle                      | Family, lifestyle, parenting, gentle explanations             |
| `zhixingnv`          | 知性女声         | Knowledgeable Female | female, middle-aged, calm, knowledge, explainer                | Education, culture, thoughtful explainers                     |
| `dayi`               | 大壹             | Dayi                 | male, young, steady, formal, documentary, video-voiceover      | Formal voiceover, documentary, corporate narration            |
| `jitangnv`           | 鸡汤女           | Inspirational Female | female, young, warm, inspirational, emotional, video-voiceover | Motivational, uplifting, emotional video narration            |
| `liuchang`           | 流畅女声         | Smooth Female        | female, young, smooth, polished, video-voiceover, narration    | Clean product narration and polished video voiceover          |
| `ruyayichen`         | 儒雅逸辰         | Yichen               | male, young, elegant, premium, culture, video-voiceover        | Cultural, premium, poetic, documentary-style narration        |
| `morgan`             | Morgan           | Morgan               | male, middle-aged, deep, knowledge, explainer                  | Deep knowledge explainer, documentary, serious narration      |
| `qingcang`           | 擎苍             | Qingcang             | male, old-like, authoritative, audiobook, character            | Weighty narration, dramatic reads, audiobook scenes           |
| `huiben`             | 儿童绘本         | Storybook Voice      | female, young, gentle, storybook, audiobook                    | Gentle storybook or bedtime-style narration                   |
| `popo`               | 婆婆             | Grandma              | female, old, warm, story, character                            | Grandmother characters, folk stories, nostalgic narration     |
| `yuanboxiaoshu`      | 渊博小叔         | Erudite Uncle        | male, middle-aged, knowledge, calm, explainer                  | Calm explainers, cultural commentary, educational narration   |
| `baqiqingshu`        | 霸气青叔         | Confident Uncle      | male, middle-aged, confident, audiobook, narrative             | Audiobook narration, long-form stories, dramatic reads        |
| `shuanglangshaonian` | 爽朗少年         | Cheerful Teen        | male, young, cheerful, youthful, roleplay, character           | Bright roleplay, teen/creator dialogue, youthful scenes       |
| `tangseng`           | 唐僧             | Tang Seng            | male, old-like, calm, roleplay, character                      | Monk-like dialogue, traditional stories, steady narration     |

Important caveat: the current Doubao seed-tts-2.0 resource does not expose an
explicit general-purpose old-male voice. `qingcang` and `tangseng` are
old-like approximations, not guaranteed old-male controls.

### Doubao Control Support

Base controls for curated Doubao voices: `speedRatio`, `loudnessRatio`, and
`pitch`.

Expressive controls:

- Supports `emotion`, `emotionScale`, `performancePrompt`, and ASMR-style prompt
  directions: `vivi`, `xiaohe`, `yunzhou`, `xiaotian`, `naiqimengwa`,
  `yingtaowanzi`, `wenroumama`, `zhixingnv`, `dayi`, `jitangnv`, `liuchang`,
  `ruyayichen`, `morgan`, `qingcang`, `huiben`, `popo`, `yuanboxiaoshu`,
  `baqiqingshu`, `tangseng`.
- `shuanglangshaonian` supports `performancePrompt` and COT/QA-style
  instruction following only. Do not use `emotion`, `emotionScale`, or
  ASMR-style prompt directions with this voice.
- `explicitDialect` is only supported by `vivi`; allowed values are `dongbei`,
  `shaanxi`, and `sichuan`.

## ElevenLabs English / Multilingual Voices

Use ElevenLabs for English or multilingual narration. Official accent labels
are English-source voice cues, not target-language accent controls.

| Preset      | Tags                                                       | Selection hint                                             |
| ----------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| `amelia`    | female, young, upbeat, narrative-story, social-media       | Story reads, podcast intros, reels, enthusiastic ads       |
| `brittney`  | female, young, upbeat, social-media, fun                   | Creator videos, recaps, hot-topic commentary, how-to clips |
| `hope`      | female, young, upbeat, clear, social-media                 | Crisp short-form narration and quick explainers            |
| `jessica`   | female, middle-aged, calm, conversational, narrative-story | Composed narration, confident product copy, direct reads   |
| `arabella`  | female, young, gentle, emotive, narrative-story            | Fantasy, romance, wellness, atmospheric stories            |
| `jane`      | female, old, professional, audiobook, narrative-story      | Long-form book pacing and classic narration                |
| `maria`     | female, old, calm, grandmother, narrative-story            | Grandmother-style narration and reflective story delivery  |
| `mark`      | male, young, casual, conversational, natural               | Dialogue, assistant-style replies, informal scripts        |
| `frederick` | male, middle-aged, calm, documentary, narrative-story      | History, science, mystery, factual films                   |
| `peter`     | male, middle-aged, confident, credible, narrative-story    | Trustworthy narration, explainers, brand reads             |
| `james`     | male, middle-aged, deep, husky, narrative-story            | Audiobooks, heavier story narration, professional VO       |
| `jon`       | male, middle-aged, calm, grounded, narrative-story         | Clear messaging, commercials, trustworthy narration        |
| `sully`     | male, old, deep, storyteller, narrative-story              | Deep elderly narration and warm authoritative reads        |
| `david`     | male, old, deep, storyteller, narrative-story              | Classic audiobook passages and grounded dramatic reads     |
| `alex`      | male, young, confident, entertainment-tv, social-media     | YouTube, shorts, entertainment clips                       |

### ElevenLabs Control Support

All current curated ElevenLabs presets support the same request-level controls:
`modelId`, `speed`, and `stability`.

Important limits:

- These controls are provider/model-level controls, not per-voice capability
  switches. No current curated ElevenLabs preset is excluded from them, but the
  audible result varies by the source voice's natural delivery.
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

## Audition Samples

Each curated preset has a local editor sample under:

```text
/voice-samples/<provider>-<preset>.mp3
```

Examples:

- `/voice-samples/doubao-morgan.mp3`
- `/voice-samples/doubao-zhixingnv.mp3`
- `/voice-samples/elevenlabs-peter.mp3`
- `/voice-samples/elevenlabs-sully.mp3`

Prefer these samples when rendering a voice audition widget before calling
`submit_voice`.
