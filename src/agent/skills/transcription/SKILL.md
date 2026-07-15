---
name: transcription
description: Use when a video/audio task needs ChatCut transcription, captions, subtitles, subtitle styling, transcript search, transcript readiness checks, or enabling captions from Codex, including local or attached videos where the user asks to add captions/subtitles, transcribe, create bilingual subtitles, clean talking-head speech, remove filler words, or trim pauses.
---

# Transcription

For newly imported local/client-held media, use `import_media` to start transcription, then wait with `track_progress`.

Typical flow:

1. `read_project` with `view: "assets"` to get the video/audio asset ID and transcript status.
2. If this is a fresh client-held import, make sure it went through `import_media action=create_session` plus the ChatCut media import helper.
3. Call `track_progress` with `action:"wait"`, `target:"transcription"`, and `assetIds` set to the asset ID or prefix.
4. Use `find_transcript` to search transcript text and confirm word timestamps.
5. Use `edit_captions` action `enable` or `read_captions` as needed once transcription is ready.

Example:

```json
{
  "action": "wait",
  "target": "transcription",
  "assetIds": "13c1aa02cd"
}
```

For S3-backed assets imported through the helper, finalization starts ASR but does not wait. Always use `track_progress` for readiness.

For local-only video assets with `local-only; original upload deferred` in `read_project`, transcription cannot run until the bytes are reachable by the backend. Import the source again via the `asset-import` skill (which uploads to S3) or `download_media` from a public URL; do not ask the user to relink it manually in the editor.

## Stuck Transcription And Retry

Do not declare transcription stuck from one non-terminal status. Base the decision on both asset length and the time Codex has actually waited in this task.

1. Read the asset with `read_project` `view: "assets"` and note its duration when available.
2. Start counting elapsed wait time from the first `track_progress` `action:"wait"` or from the earliest reliable in-task timestamp where Codex observed transcription as pending/running.
3. If transcription reports an explicit failed, errored, or timed-out terminal state, retry immediately after confirming the asset is remote-ready and is video/audio.
4. If transcription remains pending/running with no failure, treat it as stuck only after elapsed wait time exceeds `max(5 minutes, min(60 minutes, 2 × asset duration))`. For example, wait at least 5 minutes for a 30-second clip, about 20 minutes for a 10-minute asset, and about 60 minutes for a 1-hour or longer asset.
5. If duration is unknown, wait at least 10 minutes across more than one `track_progress` call before treating it as stuck, unless the tool reports an explicit failure.

When stuck, use `manage_transcript` with `action: "retry_transcription"` and the asset id/prefix. This force-retries ASR for audio/video assets and starts a new transcription run; it does not wait for completion. After retrying, call `track_progress` with `target:"transcription"`, `action:"wait"`, and the returned or same asset id before reading transcripts or captions.

Example retry:

```json
{
  "action": "retry_transcription",
  "asset": "13c1aa02cd"
}
```

If captions read back as empty, check the source-time range of the timeline clip. A transcript can be ready while the current visible clip starts before the first spoken word; add or trim a clip so the transcribed source words fall inside the timeline range, then extend/update the captions item duration if needed.

Use the raw tools when you need finer control:

- `track_progress` with `target: "transcription"` for status/wait.
- `find_transcript` for query-based transcript lookup.
- `read_captions` and `edit_captions` for caption display edits.
- `manage_transcript` action `fix` for source transcript repair.
- `manage_transcript` action `retry_transcription` to force-retry ASR after a transcription is stuck, timed out, or failed.
- `clean_script` for mechanical timeline playback cleanup of fixed fillers and batch pauses after transcript-ready media is on the timeline.

When a transcript-ready request becomes an editorial talking-head edit, follow the public-safe talking-head workflow in shared `talking-head-guide`. In short: use `clean_script` only for mechanical cleanup, then use Script (`read_script` -> edit `timeline.md` -> `apply_script`) for semantic repeated-take, silence, filler, or coherence edits, and verify the resulting script rather than trusting tool success alone.
