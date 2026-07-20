---
name: known-errors
description: Use when a OpenChatCut tool call fails or returns an unexpected shape.
---

# Known Errors

`edit_item` update raw shape:

- Wrong: `{ "id": "abc", "fromFrame": 30 }`
- Right: `{ "json": "{\"updates\":[{\"id\":\"abc\",\"fromFrame\":30}]}" }`
- Use this same `updates` shape for common moves, trims, and track changes.

`edit_item` add raw shape:

- The new item goes inside the `adds` array of the `json` transaction: `{ "json": "{\"adds\":[{...}]}" }`.
- Use `edit_item` for simple video placement, for example `{ "json": "{\"adds\":[{\"type\":\"video\",\"assetId\":\"...\",\"fromFrame\":0}]}" }`.

Timeline overlap:

- Error text: `Overlap: updated item at ... would overlap existing item at ... on this track.`
- Do not force the write or delete the conflicting item silently.
- Retry the `edit_item` transaction with an explicit available `trackId`, for example an update containing `"trackId":"V2"`, or ask the user which layer should win.

Workspace path restrictions:

- `push_asset` on the external MCP only accepts public http(s) URLs as `filePath`. It rejects local paths, workspace paths, and chat attachment paths.
- For motion-graphic assets, pass the JSX source via `create_motion_graphic_from_code({ code:"...", name, width, height, durationInFrames })`. `push_asset` no longer accepts an inline `code` argument.
- Copying local media into the workspace is not the fix for video/audio/image/GIF imports; use `asset-import` and `import_media` instead.
- Use `import_media action=create_session`, then run the OpenChatCut media import helper once with the returned token for client-held files.

Browser video conversion failure:

- Error text often includes `Unable to convert video without dropping audio/video tracks` or `unknown_source_codec`.
- Rerun the OpenChatCut media import helper; it owns frontend-aligned conversion and will surface a user-actionable error if conversion is impossible.
- Do not ask the user to re-import the same file through the editor UI as a workaround — the conversion path is the same, the error will repeat. Fix the source (re-encode locally with `ffmpeg`) or pick a different file.
- After the replacement asset is uploaded/transcribed, delete the failed original asset if it is unused. The clean final media pool should look like a successful import, not a failed import plus a replacement.

Motion Graphic requirements:

- `push_asset(type:"motion-graphic")` requires `width`, `height`, and `duration` or `durationInFrames`.
- MG code must pass the OpenChatCut validator.
- Root `AbsoluteFill` is not valid for generated MG code; use a scaling root `div`.
- Avoid declaring a top-level local named `scale` inside MG code. The validator/runtime may already reserve that identifier; use a specific name such as `uiScale`.

Local dev Zero caveat:

- When backend runs on a non-default port, use a matching Zero view-syncer configuration.
- In this POC, backend `3010`, editor `5177`, and view-syncer `4850` are intentionally isolated from the older `3000/5173/4848` stack.

Timeline frame renderer caveat:

- If `view_timeline_frames` fails for one frame, the project write path can still be healthy — retry with fewer frames or a different time before concluding anything.
- Assets still on `blob:` placeholders (upload in flight) render as empty; wait for `track_progress` target=upload before treating a blank frame as a bug.
- Do not report visual proof success unless the tool returns image content that visibly confirms the target frame.
