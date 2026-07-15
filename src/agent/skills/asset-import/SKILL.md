---
name: asset-import
description: Use when acquiring or importing media into a ChatCut project asset library for video editing or creation, including local/attached videos, user-provided paths, public media URLs, web video/audio/image assets, upload fallback decisions, and deciding between import_media, download_media, or manual user action.
---

# Asset Import

For files readable by Codex shell, including `/Users/...`, `/tmp/...`, and chat attachments materialized as files: use the ChatCut media import helper plus `import_media`.

If the helper/upload command is denied by host policy or auto-review because it would transfer private local file contents to ChatCut's external API, stop immediately. Do not inspect, transcode, copy, edit, register local-only, render locally, or try any alternate local workflow. Tell the user that Codex was denied permission to upload the file, then ask them to either upload the media in the right panel ChatCut editor or restart/run Codex with higher permission for this upload.

The helper is mandatory for import prep/upload. Do not run `ffprobe`, `ffmpeg`, `curl`, metadata inspection, extraction, transcode, or presigned-upload commands yourself as a replacement for the helper. Do not copy local media into the workspace to make `push_asset` accept it. The only local command you should run for import prep/upload is this skill's `scripts/upload-media.mjs`. Separate visual verification/source-frame inspection may use Codex-native local file tools such as `ffmpeg`; follow the `verification` skill for that. The helper's technical media preparation is not permission to make an editorial pre-render or flattened final video locally.

MCP OAuth stays inside the MCP client. The helper uses only the short 30-minute import token returned by `import_media`; never pass OAuth tokens to shell. The helper is at `scripts/upload-media.mjs` relative to this skill file (`skills/asset-import/SKILL.md`); resolve that path directly, do not search the workspace.

Before running the JavaScript helper, resolve the Codex bundled Node runtime with `load_workspace_dependencies` when that host tool is available, then run `upload-media.mjs` with the returned `node.exe`/`node` path. Do not install Node.js or assume global `node` exists. If `load_workspace_dependencies` is unavailable, first check whether bundled dependencies are already present; only then fall back to globally installed `node`.

Run the helper out of sandbox by default. It requires access to the user's local source media paths, the plugin's installed helper script, the Codex bundled Node runtime, and the network import endpoint, so request approval before executing instead of attempting a sandboxed run first. Do not retry the same helper command inside the sandbox after an approval/out-of-sandbox path is available.

Required flow for one or many readable files:

1. Call `import_media` with `{"action":"create_session"}`.
2. Run the plugin-provided helper once with the returned `token`, `endpoint`, and every local file path. Do not call `import_media` again for those files. The helper returns registered `assetId`s as soon as placeholders are created; upload and transcription work may continue after the IDs are known.

For multi-source edits, build reviewable work from original source assets in the ChatCut timeline. Do not locally concatenate, pre-trim, pre-compose, burn captions, mix down, or render a "review MP4" merely to reduce the number of files uploaded. Use judgment on sequencing: start import for obvious or likely-needed originals when that keeps work moving, and inspect local source frames in parallel when helpful. Do not make a separate local source-selection pass a mandatory gate before upload. If the user explicitly asks Codex to choose among many sources, or importing every file is clearly unreasonable, choose a bounded subset and import those originals through this flow.

```bash
"<bundled-or-global-node>" <this-skill-dir>/scripts/upload-media.mjs --token <token> --endpoint <endpoint> /path/to/source-1.mp4 /path/to/source-2.wav --json-out /tmp/chatcut-imports.json
```

```powershell
& "<bundled-node-path>\node.exe" "<this-skill-dir>\scripts\upload-media.mjs" --token <token> --endpoint <endpoint> C:\path\to\source-1.mp4 C:\path\to\source-2.wav --json-out $env:TEMP\chatcut-imports.json
```

For non-SVG media imports, the helper registers an asset placeholder first and writes `imports[].result.assetId` to `--json-out` before the final media bytes are necessarily uploaded. The helper runs foreground by default, so the command may still be transcoding or uploading after the JSON appears. If the helper command is still running but the `--json-out` file exists and contains an `assetId`, read that JSON immediately and continue timeline placement or other metadata-only edits; do not wait for the helper process to exit. SVG imports keep the legacy direct `prepare`/`complete` path and return after upload completion. Video imports are always transcoded and normalized to 30fps before the final media upload. Once that `assetId` is present in helper output/status, timeline placement and other metadata-only edits can proceed; do not wait for byte upload just to place or organize the asset.

Transcription audio is prepared, uploaded, and started before the large asset byte upload whenever readable audio exists. If audio/video assets were imported, call `track_progress` with `target:"transcription"` before transcript/caption work. For source-frame inspection, prefer the helper's returned `sourcePath` and inspect locally with Codex-native tools; do not wait for upload or call `view_asset_frames` when the original path is readable. Wait for `target:"upload"` only before byte-dependent work that truly requires ChatCut/cloud bytes, such as export/render, `pull_asset`, or remote `view_asset_frames` for an asset whose original file path is not available.

Use precise wording when reporting progress: if the placeholder is registered, say the `assetId` is already known or available. If you are still waiting, say exactly what you are waiting for, such as helper output/status confirmation, transcription readiness, or byte upload completion. Do not say you are waiting for upload to finish "to get the asset id" after registration has happened.

The published plugin bundles compressed FFmpeg binaries for Apple Silicon macOS and x64 Windows. The helper resolves explicit `--ffmpeg`/`--ffprobe` arguments first, then environment overrides, then the matching bundled binaries, and finally `ffmpeg`/`ffprobe` on `PATH`. If the helper still reports a missing or broken media binary, first attempt to fix it yourself using available shell/package-manager capabilities in the current environment. Only ask the user to install or fix ffmpeg if self-repair is unavailable, blocked, or fails. Do not guess or rewrite helper metadata.

For code assets such as hand-authored Motion Graphics, use the Codex-only `create-motion-graphics` skill. It uses `create_motion_graphic_from_code` for new inline-code MG assets, then `edit_item` when the asset should be placed on the timeline. Do not write generated code to repo files, local temp files, local HTTP servers, or guessed backend workspaces.

Record source URL/path and acquisition method in trace notes when validating plugin behavior.

## Local-Only Import (no S3 upload)

Use this path when the user wants asset bytes to stay on their machine — typical Codex case where the user only intends to export locally via the `export` skill and never needs the file in the cloud editor or a share link.

Pre-requisite: the `chatcut` CLI is installed on the user's machine (`npm install -g @chatcut/skill` or via the user's preferred package manager). The CLI persists `assetId → absolute path` to a shared local store that local export tools can read.

Flow per file:

1. Call `import_media` with `{"action":"create_session"}` once for the project.
2. For each readable local file, run:

```bash
chatcut register --token <token> --endpoint <endpoint> --path /path/to/source.mp4
```

3. The command prints the new `assetId` on stdout. Use that id with `edit_item` and other timeline tools, exactly as if the asset had been uploaded.

When NOT to use this path:

- The user wants the project to be sharable, opened on another machine, or rendered via cloud export. Cloud render rejects projects whose assets have no `remoteUrl` — the LLM will see a clear 400 telling it to use local export instead.
- The user explicitly asks to upload.

For the share-able / cloud-ready path, keep using `scripts/upload-media.sh` exactly as documented above. The two paths can coexist in the same project; only the bytes-only-local assets force the local-CLI export path.
