# Atlas Cloud

Use Atlas Cloud as an optional text-to-music provider through the asynchronous audio API.

## Configuration

Set `ATLASCLOUD_API_KEY`. Override these only when needed:

- `ATLASCLOUD_API_BASE` defaults to `https://api.atlascloud.ai/api/v1`.
- `ATLASCLOUD_MUSIC_MODEL` defaults to `minimax/music-2.6`.

## Supported input

Use `provider:"atlas"` with `mode:"t2m"`. Pass a required style prompt and optionally:

- `lyrics` (up to 3500 characters)
- `isInstrumental`
- `audioFormat`: `mp3`, `wav`, or `pcm`
- `sampleRate`: `16000`, `24000`, `32000`, or `44100`
- `bitrate`: `32000`, `64000`, `128000`, or `256000`

Do not pass MiniMax cover controls, `lyricsOptimizer`, or Mureka IDs/modes. Submission is a single paid POST. OpenChatCut records the prediction ID, polls with bounded backoff, and can resume polling without submitting another generation.
