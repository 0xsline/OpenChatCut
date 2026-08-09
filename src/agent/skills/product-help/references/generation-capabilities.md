# Generation capabilities (as wired)

Short map of cloud generation tools → providers. Use this when guiding setup or choosing a model. Exact availability is always the live **capabilities** block in the agent prompt.

## Video · `submit_video`

| Model | Provider | Wired highlights |
| --- | --- | --- |
| `seedance2` | Volcengine Seedance | T2V / I2V / first+last / multi-ref; 2–15s; **480p–4k**; audio/seed/camera/watermark/last-frame/expiry/priority |
| `kling` | Kling Omni | T2V / I2V / first+last; images ≤7 (≤4 with video); **1× refVideo** `feature`\|`base`; multi-shot customize/intelligence; 3–15s; std/pro |
| `hailuo` | MiniMax | T2V / I2V / first+last; **6\|10s**; 512P (Hailuo-02), 720p→768P, 1080P→6s; optimizer controls; **S2V-01** subject |

**Not wired:** Kling element library / voice bind; provider callback URLs; arbitrary third-party generation endpoints.

## Image · `submit_image`

| Model | Notes |
| --- | --- |
| `gpt-image-2` | Text + refs (≤16); custom dimensions, mask, background, moderation, fidelity, PNG/JPEG/WebP/compression |
| `nano-banana` | Gemini; best multi-ref (≤14) |
| `image-01` | MiniMax; one subject ref via R2; custom dimensions, count ≤9, prompt ≤1500, seed, optimizer default false |

## Voice · `submit_voice`

| Provider | Notes |
| --- | --- |
| `doubao` | CN curated voices; speedRatio, emotion, emotionScale, pitch (ffmpeg), dialect, performancePrompt |
| `elevenlabs` | Curated multilingual voices; complete voice settings, continuity/dictionaries, seed, normalization, logging/latency and official output formats |
| `minimax` | Curated system voices; voice/audio settings, language/normalization, pronunciation, timbre mix, voice modify/effects, subtitles |
| `inworld`, `fishaudio`, `speechify` | Account/provider voice ID plus optional model ID only; no bundled OpenChatCut samples |
| `openai` | AI SDK speech; configured model defaults to `gpt-4o-mini-tts`; model/speed/output/instructions |
| `gemini` | AI SDK speech; configured model defaults to `gemini-2.5-flash-preview-tts`; model/output/instructions |
| `mistral` | AI SDK speech; configured model defaults to `voxtral-mini-tts-2603`; model/output |
| `cartesia` | AI SDK speech; configured model defaults to `sonic-3`; model/speed/language/output |

Every provider is opt-in and requires a concrete provider-specific `voiceId`.
Only Doubao, ElevenLabs, and MiniMax have curated choices in the voice skill;
never invent samples for the other providers. `submit_voice` creates a media-pool
asset only and does not place it on the timeline.

## Transcription · `transcribe_track`

`transcribe_track` uses the provider selected in Settings by default; AssemblyAI
remains the default. Pass `provider` only when the user explicitly requests a
configured override. Results are normalized before they are attached to clips,
with word/speaker detail preserved when the provider supplies it.

| Provider | Configuration/default |
| --- | --- |
| `assemblyai` | `ASSEMBLYAI_API_KEY`; existing upload/job resume path |
| `local` | On-device model selected in Settings; no cloud key |
| `openai` | `OPENAI_API_KEY`; `OPENAI_TRANSCRIPTION_MODEL` defaults to `gpt-4o-mini-transcribe` |
| `mistral` | `LLM_MISTRAL_API_KEY`; optional `LLM_MISTRAL_BASE_URL`; `MISTRAL_TRANSCRIPTION_MODEL` defaults to `voxtral-mini-latest` |
| `deepgram` | `DEEPGRAM_API_KEY`; `DEEPGRAM_TRANSCRIPTION_MODEL` defaults to `nova-3` |
| `groq` | `GROQ_API_KEY`; optional `GROQ_BASE_URL`; `GROQ_TRANSCRIPTION_MODEL` defaults to `whisper-large-v3-turbo` |
| `elevenlabs` | `ELEVENLABS_API_KEY`; `ELEVENLABS_TRANSCRIPTION_MODEL` defaults to `scribe_v2` |
| `cartesia` | `CARTESIA_API_KEY`; `CARTESIA_TRANSCRIPTION_MODEL` defaults to batch-capable `ink-whisper` |

## Music · `submit_music`

| Provider | Notes |
| --- | --- |
| `mureka` | Instrumental, lyrics-song, prompt-song, soundtrack from image/video, track/stem; count 1–3 and all official controls |
| `minimax` | t2m plus cover via project audio or `coverFeatureId`; official audio settings |

## Sound · `submit_sound`

ElevenLabs sound-generation: optional duration 0.5–30, influence 0–1, loop (v2), and all official MP3/PCM/μ-law/A-law/Opus formats. Prefer library SFX first.

## Keys

See [providers-and-keys.md](providers-and-keys.md). Configure in Settings or `.env.local`.

## Checks

`npm test` covers generation jobs plus video, image, music, voice, and sound validators.
