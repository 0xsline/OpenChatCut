---
name: asset-import
description: Use when acquiring or importing media into a OpenChatCut project asset library for video editing or creation, including local/attached videos, user-provided paths, public media URLs, web video/audio/image assets, upload fallback decisions, and deciding between import_media, download_media, or manual user action.
---

# Asset Import

This build runs the editor and its media server locally. There is no hosted import API, no CLI, and no OAuth: media enters the project through the editor UI or through the agent tools below. Pick the path by where the bytes live.

## Path 1 — user's local files (primary)

Ask the user to drag the files into the editor (preview canvas or 我的素材 panel) or use the upload button. The local pipeline then runs automatically: streaming write to `/media/uploads/`, conditional transcode (≤1920 long edge, browser-friendly codec, ~8Mbps), audio extraction, and auto-transcription (ASR starts on upload). Do not ask the user to pre-convert, pre-trim, or transcode anything themselves — the pipeline handles it.

The agent cannot read the user's filesystem. If the user gives you a `/Users/...` or `C:\...` path, tell them to drop that file into the editor instead; you cannot fetch it.

## Path 2 — public URLs (agent-driven)

Use `download_media` with up to 4 URLs per call. The server fetches, stores under `/media/uploads/`, and registers pool assets. Prefer this for stock/web media the user pointed at. After download, the asset behaves exactly like an upload (same transcode/ASR pipeline).

## Path 3 — external host transfer

Call `import_media` with `{"action":"create_session", "assetType":..., "filename":..., "contentType":..., "size":...}`. It returns one short-lived upload slot bound to the current project, session, asset identity, basename, `POST`, MIME type, and exact byte count. A host-side script may upload to that exact URL with the declared headers. The agent sandbox cannot reach the user's localhost, so do not attempt the transfer from `run_code`.

The successful upload response returns an opaque receipt and uploaded path. Probe the uploaded path when exact duration, dimensions, fps, or audio presence are needed, then call `finalize_uploaded_asset` with only the receipt and measured media metadata. The server resolves the authoritative hash, path, size, filename, and asset id. The asset is not present or usable before finalize succeeds. For missing-media replacement, pass the existing `assetId` to `import_media`; omit it for a new asset. Never construct `/media/uploads/...` yourself and never claim bytes are ready before the upload response.

## Editing discipline

For multi-source edits, build reviewable work from original source assets in the OpenChatCut timeline. Do not locally concatenate, pre-trim, pre-compose, burn captions, or flatten media before import — import originals and do all composition on the timeline so every step stays reviewable and undoable.

For code assets such as hand-authored Motion Graphics, use the `create-motion-graphics` skill (`create_motion_graphic_from_code` for new assets, asset-code updates for edits) — MG code is not an imported file.

## Storage notes

- Bytes live on the local disk (`/media/uploads/`), served directly with Range support. If Cloudflare R2 is configured, uploads mirror to R2 and other devices can hydrate from it; without R2 the project is local-only.
- Local-only is a valid end state: preview, editing, and export all read from disk. Cloud mirroring is only needed for cross-device access.
