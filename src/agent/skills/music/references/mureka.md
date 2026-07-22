# Mureka (`provider: "mureka"`)

OpenChatCut wires the official Mureka generate/query and file-upload APIs. The configured model is `MUREKA_MUSIC_MODEL` (default `auto`; official choices include `mureka-7.6`, `mureka-o2`, `mureka-8`, `mureka-9`, with endpoint-specific support).

## Modes

| Mode | Endpoint | Key controls |
| --- | --- | --- |
| `instrumental` | `/v1/instrumental/generate` | exactly one of `prompt` ≤1024 or `instrumentalId`; `count` 1–3; `stream` |
| `song` | `/v1/song/generate` | `lyrics` required ≤5000; prompt ≤1024; gender/referenceId/vocalId/melodyId; count/stream |
| `prompt-song` | `/v1/song/easy-generate` | prompt ≤2000; styles/referenceId/vocalId; count/stream |
| `soundtrack` | `/v1/soundtrack/generate` | project image/video `sourceAssetId`; prompt ≤1024; count; optional audio start/end (≥3s range) |
| `track` | `/v1/track/generate` | exactly one of `songId` or audio `sourceAssetId`; `trackType`; required prompt ≤1024; ranges/lyrics/vocalGender |

`sourceAssetId` is uploaded server-side with official purpose `soundtrack` or `audio`. Track types: `Vocals`, `Instrumental`, `Drums`, `Bass`, `Guitar`, `Keyboard`, `Percussion`, `Strings`, `Synth`, `FX`, `Brass`, `Woodwinds`.

Prompt-song styles: `pop`, `rock`, `jazz`, `r&b`, `edm`, `ambient`, `folk`, `latin`, `k-pop`, `j-pop`, `house`, `gospel`, `lo-fi`.

Output selection: `audioFormat` may be `mp3`, `wav`, or `flac`. Every returned choice is downloaded and becomes a distinct asset. OpenChatCut defaults `count` to 1 rather than Mureka's official default 2 to avoid surprise charges.

## Combinations

- `melodyId` is standalone; do not combine it with prompt/referenceId/vocalId.
- `mureka-o2` does not support vocalId or melodyId and is not valid for instrumental/soundtrack endpoints.
- `vocalGender` applies only to `trackType:"Vocals"`.
- Soundtrack `audioStartMs`/`audioEndMs`, when both supplied, must select at least 3000ms.
