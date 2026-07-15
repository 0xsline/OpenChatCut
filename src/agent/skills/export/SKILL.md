---
name: export
description: Use when a ChatCut video editing or creation workflow needs export, render, download, share, final delivery, subtitle-file export, local versus cloud render choice, local-only asset handling, or export fallback explanation from Codex.
---

# Export

Use ChatCut's durable export jobs for Codex-visible delivery. A ChatCut export request from Codex should call `submit_export`, then use `track_export` for status and final delivery when the result is not returned immediately. Do not use share-link tools for connector exports.

Default policy:

- Prefer `submit_export` when the user asks to export/share/finalize the ChatCut timeline.
- Keep originals local by default during editing. Upload originals only when a cloud export/proof needs remote assets and the user has not forbidden upload.
- Do not wrap Codex-native `ffmpeg` work as a ChatCut tool. Use local `ffmpeg` for full video processing only when the user explicitly asks for a standalone local-file operation outside a ChatCut editing workflow. For ChatCut editing tasks, do not produce a pre-edited or flattened local render as the primary review/final deliverable; use ChatCut export.

## Durable Export

Use `submit_export` for the execution path:

```json
{
  "format": "video",
  "codec": "h264",
  "resolution": "1080p",
  "fps": 30,
  "name": "final-cut"
}
```

Video codec options are `h264` (MP4, default) and `vp8` (WebM). Video frame-rate options match the editor UI: `24`, `25`, `30`, `50`, or `60`; omit `fps` to match the timeline. Audio export is MP3: pass `"format":"audio"` and omit `codec` / `fps` unless you explicitly pass `"codec":"mp3"`.

`submit_export` returns a durable `renderId`. Some export types, such as subtitle files, may complete immediately and return `downloadUrl`; video/audio usually require `track_export` to wait for completion.

After getting each `downloadUrl`:

- Resolve the user's Downloads folder: `~/Downloads` on macOS/Linux, or `%USERPROFILE%\Downloads` on Windows.
- Before triggering any agent/browser download, check the Downloads folder for fresh Chrome download artifacts from the last few minutes that match the expected export name, extension, or render/download URL basename. Include both completed files and in-progress `.crdownload` files.
- If a matching fresh `.crdownload` exists, do not trigger another download. Wait until Chrome removes the `.crdownload` suffix and the final file size stops changing, then use that completed file.
- If a matching fresh completed file already exists, use it directly instead of downloading again.
- If only older files exist, treat them as collisions, not as the current export.
- Do not overwrite an existing file; choose a safe numbered filename such as `name (1).mp4` when needed.
- Always download the finished export file into the Downloads folder, not a temp/workspace directory.
- Always show the downloaded video inline in chat. If there are multiple exported videos, download all of them and show every preview, not just the first.

If the project contains local-only assets, upload/register cloud-readable replacements before rendering, or use the Local CLI Export path when the user wants to stay local.

Report the returned `renderId` when present and tell the user the job is visible in the editor render-jobs panel.

Use `track_export` when the user asks about export/render status, or when the current turn genuinely needs to wait for a submitted video/audio render. Completed connector exports return `downloadUrl`; for every completed entry, download the file to Downloads using the collision-safe rules above and show it inline in chat:

```json
{
  "action": "status",
  "renderIds": "abc123"
}
```

For the latest project export, omit `renderIds` and pass `"latest": true`. `track_progress` is for generation/transcription/upload jobs, not render jobs.

For NLE XML, use `submit_export` with `format:"xml"`:

```json
{
  "format": "xml",
  "nleFormat": "fcp_xml_resolve",
  "timelineId": "abc123"
}
```

`nleFormat` values are `fcp_xml` for Premiere XML (default) and `fcp_xml_resolve` for DaVinci Resolve XML. Omit `timelineId` for the active timeline, or pass a timeline id/prefix for a non-active timeline. Read and report warnings: captions, solids, SVG, unsupported clip attributes, and unrendered motion graphics may be dropped by the XML format. Motion graphics are only represented in XML when a transparent-ProRes MG export flow supplies `motionGraphicRenderKeys`; otherwise the exporter reports them as dropped.

For media-pool source download, use `request_asset_download` on a file-backed source asset. It returns a guarded backend download URL/path for the original source media. Do not use `pull_asset` for user downloads; `pull_asset` is sandbox-only.

For subtitle files, use `submit_export` with `format:"subtitles"`:

```json
{
  "format": "subtitles",
  "subtitleFormat": "srt"
}
```

Formats are `srt` and `txt`. The export uses the captions item's actual timeline word timing, source scope, translation variants, display-text overrides, and pacing fields such as `wordsPerPage` / `maxCharactersPerLine`, and creates a durable downloadable export job. It is appropriate for downloadable subtitle files. It does not yet reuse the browser Remotion caption page planner, so visual line wrapping/page breaks are timing-correct but approximate rather than byte-identical to burned-in caption pagination. For non-active timelines, pass `timelineId` from `manage_timelines` or `read_project`.

For one motion graphic as transparent ProRes 4444, use `export_motion_graphic_prores`:

```json
{
  "itemId": "abc123",
  "filenameMode": "asset"
}
```

Prefer `itemId` when exporting a specific timeline instance, because the item carries live `propertyOverrides` such as edited text. Use `assetId` for a media-pool motion graphic; the backend will use the first timeline instance for that asset when present, matching the editor's media-pool export behavior. For several motion graphics, pass `itemIds` or `assetIds` in one call. Each motion graphic still becomes a separate durable render; use `track_export` with the returned `renderIds` to wait, then download through each returned render download path.

When preparing XML that should reference rendered motion graphics, pass `"filenameMode":"xml"` and the same `timelineId` to `export_motion_graphic_prores`, then keep the returned `motionGraphicRenderKey` / `motionGraphicRenderKeys`; after the render completes, pass those keys and the same `timelineId` in `submit_export.motionGraphicRenderKeys` with `format:"xml"`.

## Local CLI Export (no S3)

Use this path when the project was assembled with `chatcut register` (see the `asset-import` skill) and bytes never went to S3. The cloud render endpoint will reject the job with a 400 telling you to use local export, because Lambda cannot read the user's filesystem.

Pre-requisite: the `chatcut` CLI is installed on the user's machine.

Flow:

1. Call `import_media` with `{"action":"create_session"}` to get a fresh session token.
2. Derive the render-prepare endpoint from the returned media-import endpoint by replacing the trailing `/media-import` with `/render-prepare`. The same `cmi_` token authenticates both.
3. Run:

```bash
chatcut export --token <token> --endpoint <renderPrepareEndpoint> --output ~/Downloads/<safe-name>.mp4
```

Optional flags: `--codec h264|mp3|prores|vp8` (default `h264`), `--crf <n>`, `--frame-range start-end`, `--timeline-id <id>` for a non-active timeline.

The CLI prints the absolute output path on stdout when render completes. Streams progress to stderr. Use Downloads-folder collision-safe naming exactly like the bridge export path (numbered suffix when a file already exists).

This is the only export route that works for `chatcut register`-imported assets — they have no `remoteUrl` so `submit_export` will be refused.

## Fallbacks

The editor-action local bridge export path has been removed; use cloud render for connector exports.

If cloud render is blocked by local-only assets:

1. If the user's intent allows upload, use `import_media` to upload/register cloud-readable replacements.
2. If the user wants to stay local, use the Local CLI Export path above.
3. If neither is available (no `chatcut` CLI installed and upload not allowed), report that the user needs to install `@chatcut/skill` or upload originals before cloud render can proceed.

Do not tell the user they need to understand HTML-in-Canvas, Remotion Lambda, or S3 unless debugging. Explain at product level:

- "本地快速导出"
- "云端兼容导出"
- "需要先上传本地素材"

## Result Trace

For `submit_export`, record:

- `renderId`
- timeline/range/resolution/codec/fps
- that the user can download from the editor render-jobs panel

Record uploaded asset IDs and any fallback tried when cloud export was blocked by local-only assets.
