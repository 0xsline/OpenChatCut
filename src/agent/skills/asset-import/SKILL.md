---
name: asset-import
description: Use when acquiring or importing media into a OpenChatCut project asset library for video editing or creation, including local/attached videos, user-provided paths, public media URLs, web video/audio/image assets, upload fallback decisions, and deciding between import_media, download_media, or manual user action.
---

# Asset Import

This build runs the editor and its media server locally. There is no hosted import API, no CLI, and no OAuth: media enters the project through the editor UI or through the agent tools below. Pick the path by where the bytes live.

## Path 1 — user's local files (primary)

Ask the user to drag the files into the editor (preview canvas or my material panel) or use the upload button. The local pipeline then runs automatically: streaming write to `/media/uploads/`, conditional transcode (≤1920 long edge, browser-friendly codec, ~8Mbps), audio extraction, and auto-transcription (ASR starts on upload). Do not ask the user to pre-convert, pre-trim, or transcode anything themselves — the pipeline handles it.

The agent cannot read the user's filesystem. If the user gives you a `/Users/...` or `C:\...` path, tell them to drop that file into the editor instead; you cannot fetch it.

## Path 2 — public URLs (agent-driven)

Use `download_media` with up to 4 URLs per call. The server fetches, stores under `/media/uploads/`, and registers pool assets. Prefer this for stock/web media the user pointed at. After download, the asset behaves exactly like an upload (same transcode/ASR pipeline).

## Path 3 — placeholder before bytes (timeline-first work)

Call `import_media` with `{"action":"register_placeholder"}` to mint a deterministic `assetId` and pool row before bytes exist. Use it when you want to lay out the timeline (`edit_item` etc.) while an upload is still in flight; the asset relinks automatically when bytes land. Report progress precisely: once the placeholder is registered say the `assetId` is known; while bytes are still uploading say so — never claim a file is ready before `track_progress` (target=upload) confirms it.

`import_media` with `{"action":"create_session"}` returns local direct-upload endpoints (`POST /upload?name=...&assetId=...`). This is for host-side scripts the *user* runs in their own terminal (e.g. `curl -T file '/upload?...'` against the dev server); the agent sandbox cannot reach localhost, so do not try to upload from `run_code`.

## Editing discipline

For multi-source edits, build reviewable work from original source assets in the OpenChatCut timeline. Do not locally concatenate, pre-trim, pre-compose, burn captions, or flatten media before import — import originals and do all composition on the timeline so every step stays reviewable and undoable.

For code assets such as hand-authored Motion Graphics, use the `create-motion-graphics` skill (`create_motion_graphic_from_code` for new assets, asset-code updates for edits) — MG code is not an imported file.

## Storage notes

- Bytes live on the local disk (`/media/uploads/`), served directly with Range support. If Cloudflare R2 is configured, uploads mirror to R2 and other devices can hydrate from it; without R2 the project is local-only.
- Local-only is a valid end state: preview, editing, and export all read from disk. Cloud mirroring is only needed for cross-device access.
