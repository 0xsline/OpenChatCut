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
| TTS / voice | `submit_voice` | Doubao pair, `ELEVENLABS_API_KEY`, `MINIMAX_API_KEY` |
| Music | `submit_music` | `MUREKA_API_KEY`, `MINIMAX_API_KEY` |
| Sound FX gen | `submit_sound` | `ELEVENLABS_API_KEY` |
| Stock search | `search_stock_media` | `PEXELS_API_KEY`, `PIXABAY_API_KEY`, `UNSPLASH_ACCESS_KEY`, `FREESOUND_API_KEY` |
| Transcription | `transcribe_track` | `ASSEMBLYAI_API_KEY` |
| Web | `web_browser` | `FIRECRAWL_API_KEY` |
| Sandbox / ffmpeg helpers | `run_code` | `E2B_API_KEY` (if used) |
| LLM agent | chat | `LLM_API_KEY` + `LLM_PROVIDER` (`anthropic`, `openai`, `gemini`, `kimi`, `qwen`, `glm`, `deepseek`, `minimax`, `mistral`, or `openai-compatible`); Base URL and model are optional overrides |

Exact availability is reflected in the live **capabilities** block injected into the agent system prompt (which vendors are on).

## What works without cloud keys

- Timeline editing, propose→apply, captions, transitions, FX, zoom, library MG templates  
- Export (when the export path is available)  
- Project / media pool / version history  

## If the user asks about cloud cost

- Point them at their provider console (MiniMax, Volcengine, OpenAI, etc.).  
- Do not invent rates.
