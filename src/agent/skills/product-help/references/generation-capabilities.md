# Generation capabilities (as wired)

Short map of cloud generation tools → providers. Use this when guiding setup or choosing a model. Exact availability is always the live **capabilities** block in the agent prompt.

## Video · `submit_video`

| Model | Provider | Wired highlights |
| --- | --- | --- |
| `seedance2` | Volcengine Seedance | T2V / I2V / first+last / multi-ref (image/video/audio); 4–15s; **480p–4k** |
| `kling` | Kling Omni | T2V / I2V / first+last; images ≤7 (≤4 with video); **1× refVideo** `feature`\|`base`; multi-shot customize/intelligence; 3–15s; std/pro |
| `hailuo` | MiniMax | T2V / I2V / first+last; **6\|10s** (1080p → 6 only); 720p→API 768P; `promptOptimizer` / `fastPretreatment`; **S2V-01** subject via firstFrame when model set |

**Not wired:** Kling element library / voice bind; music-cover preprocess feature-id flow; arbitrary third-party endpoints.

## Image · `submit_image`

| Model | Notes |
| --- | --- |
| `gpt-image-2` | Text + refs (≤10); quality/size tiers |
| `nano-banana` | Gemini; best multi-ref (≤14) |
| `image-01` | MiniMax; no refs; count ≤9; prompt ≤1500; **`promptOptimizer`**; server model `image-01` / `image-01-live` from settings |

## Voice · `submit_voice`

| Provider | Notes |
| --- | --- |
| `doubao` | CN voices; speedRatio, emotion, emotionScale, pitch (ffmpeg), dialect, performancePrompt |
| `elevenlabs` | Multilingual; modelId, stability, speed |
| `minimax` | speed, **pitch**, **volume (vol)**, emotion; system/cloned voiceId |

## Music · `submit_music`

| Provider | Notes |
| --- | --- |
| `mureka` | Instrumental only |
| `minimax` | t2m: lyrics / lyricsOptimizer / isInstrumental / audio_setting; **cover**: `referenceAssetId` + model `music-cover*` |

## Sound · `submit_sound`

ElevenLabs sound-generation only: `prompt`, `durationSeconds` 0.5–22, `promptInfluence` 0–1. Prefer library SFX first.

## Keys

See [providers-and-keys.md](providers-and-keys.md). Configure in Settings or `.env.local`.

## Checks

```bash
npm run check:generation
```

Covers generation-jobs, video, image, music, voice, sound pure validators.
