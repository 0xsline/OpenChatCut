# Providers & API Keys

AI features that call the cloud need API keys, configured in:

1. **Settings panel** (in-app), or  
2. **`.env.local`** (server-side)

If a capability is off, say so and offer alternatives (upload, library, another configured vendor).

## Capability → typical keys

| Capability | Tools (examples) | Keys (any configured vendor is enough) |
| --- | --- | --- |
| Image gen | `submit_image` | `IMAGE_API_KEY` / OpenAI, `GEMINI_API_KEY`, `MINIMAX_API_KEY` |
| Video gen | `submit_video` | `SEEDANCE_API_KEY`, `KLING_API_KEY`, `MINIMAX_API_KEY` (Hailuo) |
| TTS / voice | `submit_voice` | Provider-specific server key(s): Doubao, ElevenLabs, MiniMax, Inworld, Fish Audio, Speechify, OpenAI, Gemini, Mistral, or Cartesia |
| Music | `submit_music` | `MUREKA_API_KEY`, `MINIMAX_API_KEY` |
| Sound FX gen | `submit_sound` | `ELEVENLABS_API_KEY` |
| Stock search | `search_stock_media` | `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY`, `FREESOUND_API_KEY` |
| Transcription | `transcribe_track` | The provider selected in Settings (or an explicit configured override): AssemblyAI (default), local, OpenAI, Mistral, Deepgram, Groq, ElevenLabs, or Cartesia |
| Web | `web_browser` | `FIRECRAWL_API_KEY` |
| Sandbox / ffmpeg helpers | `run_code` | `E2B_API_KEY` (if used) |
| LLM agent | chat | Configure one or more independent provider triplets: `LLM_<PROVIDER>_BASE_URL`, `LLM_<PROVIDER>_API_KEY`, and `LLM_<PROVIDER>_MODEL`. Supported provider tokens are `ANTHROPIC`, `OPENAI`, `GEMINI`, `KIMI`, `QWEN`, `GLM`, `DEEPSEEK`, `MINIMAX`, and `MISTRAL`. `LLM_PROVIDER` controls the initially selected chat provider. |

## Speech provider configuration

TTS provider keys:

- Doubao: `DOUBAO_TTS_APP_ID` + `DOUBAO_TTS_ACCESS_KEY`
- ElevenLabs: `ELEVENLABS_API_KEY`
- MiniMax: `MINIMAX_API_KEY`
- Inworld: `INWORLD_TTS_API_KEY`
- Fish Audio: `FISHAUDIO_TTS_API_KEY`
- Speechify: `SPEECHIFY_TTS_API_KEY`
- OpenAI: existing `OPENAI_API_KEY` / optional `IMAGE_BASE_URL`;
  `OPENAI_TTS_MODEL` defaults to `gpt-4o-mini-tts`
- Gemini: existing `GEMINI_API_KEY` / optional `GEMINI_BASE_URL`;
  `GEMINI_TTS_MODEL` defaults to `gemini-2.5-flash-preview-tts`
- Mistral: existing `LLM_MISTRAL_API_KEY` / optional
  `LLM_MISTRAL_BASE_URL`; `MISTRAL_TTS_MODEL` defaults to
  `voxtral-mini-tts-2603`
- Cartesia: `CARTESIA_API_KEY`; `CARTESIA_TTS_MODEL` defaults to `sonic-3`

Transcription follows the provider selected in Settings unless the user
explicitly requests a configured `provider` override. AssemblyAI remains the
default, and local transcription needs no cloud key. Cloud choices use:

- AssemblyAI: `ASSEMBLYAI_API_KEY`
- OpenAI: `OPENAI_API_KEY` / optional `IMAGE_BASE_URL`;
  `OPENAI_TRANSCRIPTION_MODEL` defaults to `gpt-4o-mini-transcribe`
- Mistral: `LLM_MISTRAL_API_KEY` / optional `LLM_MISTRAL_BASE_URL`;
  `MISTRAL_TRANSCRIPTION_MODEL` defaults to `voxtral-mini-latest`
- Deepgram: `DEEPGRAM_API_KEY`; `DEEPGRAM_TRANSCRIPTION_MODEL` defaults to
  `nova-3`
- Groq: `GROQ_API_KEY` / optional `GROQ_BASE_URL`;
  `GROQ_TRANSCRIPTION_MODEL` defaults to `whisper-large-v3-turbo`
- ElevenLabs: `ELEVENLABS_API_KEY`; `ELEVENLABS_TRANSCRIPTION_MODEL` defaults
  to `scribe_v2`
- Cartesia: `CARTESIA_API_KEY`; `CARTESIA_TRANSCRIPTION_MODEL` defaults to
  `ink-whisper` (batch transcription; `ink-2` is streaming-only)

`TRANSCRIPTION_LANGUAGE` defaults to `zh`, and
`TRANSCRIPTION_DIARIZATION` defaults to `1`. Credentials stay server-side;
agent tool inputs never contain API keys.

The Settings panel can test each LLM endpoint, read its model catalog, and save a
selected model. AI Chat only offers providers with a configured key; switching
the chat model does not overwrite another provider's URL, key, or model.

Exact availability is reflected in the live **capabilities** block injected into the agent system prompt (which vendors are on).

## What works without cloud keys

- Timeline editing, propose→apply, captions, transitions, FX, zoom, library MG templates  
- Export (when the export path is available)  
- Project / media pool / version history  

## If the user asks about cloud cost

- Point them at their provider console (MiniMax, Volcengine, OpenAI, etc.).  
- Do not invent rates.
