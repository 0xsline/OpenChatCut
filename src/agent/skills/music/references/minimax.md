# MiniMax Music (`provider: "minimax"`)

Read this before `submit_music({ provider: "minimax", … })`.

Grounded in OpenChatCut’s music adapter (`server/plugins/music.ts` → MiniMax
`/v1/music_generation`). Official fields: `prompt`, `lyrics`, `is_instrumental`,
`lyrics_optimizer`, `audio_setting`, `output_format`, and cover refs
(`audio_base64` / `audio_url`).

Server MiniMax model comes from Settings `MINIMAX_MUSIC_MODEL`
(`music-3.0` / `music-2.6` / free / **cover** variants).

## Capabilities (as wired)

| Dimension | Value |
| --- | --- |
| Provider arg | `minimax` |
| Prompt | t2m ≤ **2000**; cover style **10–300** |
| Lyrics | t2m ≤ **3500**; cover optional **10–1000** |
| Instrumental | `isInstrumental` or omit lyrics (t2m only) |
| Lyrics optimizer | `lyricsOptimizer: true` + empty lyrics (t2m only) |
| Cover reference | `referenceAssetId` → project audio → `audio_base64` |
| Audio setting | `sampleRate` / `bitrate` / `audioFormat` |
| Placement | **Media pool only** |

## Modes

| Intent | Args | Settings model |
| --- | --- | --- |
| BGM / instrumental | omit `lyrics` | music-2.6 / 3.0 / free |
| Song with lyrics | `lyrics: "…"` | music-2.6 / 3.0 / free |
| Auto lyrics | `lyricsOptimizer: true` | music-2.6 / 3.0 / free |
| **Cover / 翻唱** | `referenceAssetId` + style `prompt` | **music-cover** or **music-cover-free** |

## Tool shape

```ts
// Instrumental BGM
submit_music({
  provider: "minimax",
  prompt: "Cinematic strings, hopeful, soft under dialogue",
  name: "BGM · strings",
});

// Vocals + lyrics
submit_music({
  provider: "minimax",
  prompt: "Indie folk, acoustic guitar, intimate",
  lyrics: "[Verse]\\n...\\n[Chorus]\\n...",
  name: "Song · folk",
});

// Auto lyrics from prompt
submit_music({
  provider: "minimax",
  prompt: "Rainy night pop, melancholic chorus about leaving home",
  lyricsOptimizer: true,
  name: "Song · auto lyrics",
});

// Music-cover (Settings model must be music-cover*)
submit_music({
  provider: "minimax",
  prompt: "Warm acoustic cover, intimate coffee-shop vibe",
  referenceAssetId: "audioAssetId",
  name: "Cover · acoustic",
});

// Higher-quality WAV instrumental
submit_music({
  provider: "minimax",
  prompt: "Orchestral trailer hit",
  isInstrumental: true,
  audioFormat: "wav",
  sampleRate: 44100,
  bitrate: 256000,
  name: "Hit · wav",
});
```

## Cover rules

1. Set **MINIMAX_MUSIC_MODEL** to `music-cover` or `music-cover-free` in Settings.
2. Pass **`referenceAssetId`** = project **audio** asset (local upload).
3. **Prompt** describes the *target style*, not the full song (10–300 chars).
4. Optional **lyrics** rewrite; omit to keep/ASR from the source.
5. Do not combine cover with `isInstrumental` or `lyricsOptimizer`.

If you pass `referenceAssetId` while the model is still `music-2.6`, the server errors until the cover model is selected.

## Lyrics tips

- Section tags: `[Intro]`, `[Verse]`, `[Pre Chorus]`, `[Chorus]`, `[Bridge]`, `[Outro]`, …
- Lines separated by `\n`
- For speech-under BGM, stay instrumental

## Errors

| Message | Fix |
| --- | --- |
| `MiniMax is not configured` | Set `MINIMAX_API_KEY` |
| `music-cover requires MINIMAX_MUSIC_MODEL…` | Switch model to music-cover* |
| `music-cover model requires referenceAssetId` | Pass the source track asset |
| `music-cover prompt must be at least 10 characters` | Expand style prompt |
| `minimax vocals require lyrics…` | lyrics / lyricsOptimizer / isInstrumental |
| `sampleRate must be…` | Use allowed enums |
