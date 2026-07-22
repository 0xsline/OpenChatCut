---
name: music
description: |
  Music generation via Mureka and MiniMax. Use for instrumentals, songs, soundtracks, track/stem generation, or covers through `submit_music`.
user-invocable: true
---

# Music

`submit_music` returns a generation `jobId`; call `track_progress` until every result is saved in the media pool. Placement, trim, loop, fades, and ducking remain timeline operations.

## Providers and modes

| Provider | Modes | Reference |
| --- | --- | --- |
| `mureka` | `instrumental`, `song`, `prompt-song`, `soundtrack`, `track` | [references/mureka.md](references/mureka.md) |
| `minimax` | `t2m`, `cover` | [references/minimax.md](references/minimax.md) |

Select the named/configured vendor. Default to Mureka instrumental for ordinary BGM. Use Mureka song/prompt-song when its vocal or reference controls are wanted; use Mureka soundtrack for an image/video-driven score and track mode for generating a stem/track from a song/audio source. Use MiniMax for its text-to-music and cover models.

## Shared workflow

1. Confirm provider, mode, and whether multiple paid variants are wanted.
2. Read the provider reference and pass only that provider's parameters.
3. Submit once, then call `track_progress({ target:"generation", action:"wait", jobIds:[jobId] })`.
4. Use every returned asset when `count` produced multiple results; do not assume only the legacy `result` field exists.
5. Place/trim/duck on the timeline only after actual durations are known.

## Examples

```ts
// Mureka instrumental (default count is deliberately 1)
submit_music({ provider: "mureka", mode: "instrumental", prompt: "Warm lo-fi piano bed under narration", count: 1 });

// Mureka lyrics song
submit_music({
  provider: "mureka", mode: "song", prompt: "Bright modern pop", gender: "female", count: 2,
  lyrics: "[Verse]\nCity lights open the night\n[Chorus]\nWe build the future in real time",
});

// Mureka prompt song
submit_music({ provider: "mureka", mode: "prompt-song", prompt: "A hopeful road-trip anthem", styles: ["pop", "folk"] });

// Score a project video or image
submit_music({ provider: "mureka", mode: "soundtrack", sourceAssetId: "videoAssetId", prompt: "Tense restrained documentary score" });

// Generate a stem from a Mureka song id
submit_music({ provider: "mureka", mode: "track", songId: "song-id", trackType: "Drums", prompt: "Tight punchy acoustic drums" });

// MiniMax instrumental / vocals
submit_music({ provider: "minimax", mode: "t2m", prompt: "Upbeat electronic tech intro", isInstrumental: true });
submit_music({ provider: "minimax", mode: "t2m", prompt: "Rainy night pop", lyricsOptimizer: true });

// MiniMax cover from a project audio asset
submit_music({ provider: "minimax", mode: "cover", prompt: "Warm acoustic coffee-shop cover", referenceAssetId: "audioAssetId" });
```

## Rules

- Only generate after an explicit request; `count` 2–3 can multiply provider charges, so never add variants silently.
- Mureka `stream:true` enables the provider's streaming task phase, but OpenChatCut still waits for durable final files.
- MiniMax cover requires a configured `music-cover*` model and exactly one of `referenceAssetId` or `coverFeatureId`; `coverFeatureId` also requires lyrics.
- Never mix MiniMax audio-setting fields into Mureka or Mureka IDs/modes into MiniMax.
- Generated music does not guarantee exact beat/drop timing; cut and align after generation.
