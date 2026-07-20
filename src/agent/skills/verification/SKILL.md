---
name: verification
description: Use when checking whether agent edits are reflected in the OpenChatCut project and editor.
---

# Verification

Prefer two signals:

1. `read_project` for structure: assets, tracks, items, frame placement, timeline duration.
2. A visual capture path for rendered evidence at exact frames.

Use `view_timeline_frames` for composed timeline proof. This verifies the edited OpenChatCut timeline: trims, layers, captions, effects,
markers, placeholders, crops, transitions, and layout.

For raw source-asset frame inspection, choose the cheapest path based on where
the bytes live:

- The agent in this build has no local filesystem access; all source bytes live
  in the project media store (`/media/uploads/`). Use `view_asset_frames` with
  the project asset id — the server takes an ffmpeg contact-sheet fast path
  automatically, so it is already the cheapest source-frame route.
- `view_timeline_frames` renders the composed timeline (the editor-truth check);
  `view_asset_frames` samples raw source frames. Pick by what you are verifying.
- There is no separate `get_contact_sheet` tool in this build — the contact
  sheet is what `view_asset_frames` / `view_timeline_frames` already return.

Use local/remote source-frame artifacts only for source understanding, moment
selection, and rough trim decisions, not as edited output or timeline proof.

For local-only or upload-in-progress media, composed timeline proof may be
blocked until the asset has bytes available to the renderer. Source-frame
inspection via `view_asset_frames` still works as long as the asset's bytes are
on disk (`/media/uploads/`).

If both visual proof paths are blocked, ask the user to inspect the OpenChatCut
editor directly and note the blocker explicitly.

Useful checks:

- After import: `read_project({ "view": "assets", "assetId": "<prefix>" })`
- After move/trim: `read_project({ "view": "timeline" })`
- After visual overlay or MG on any timeline media: `view_timeline_frames({ "frames": [30, 45, 75] })`, then look at the returned frames.
- For user-requested source selection or visual moment picking: sample stills with `view_asset_frames` and inspect them. Use that only to choose source files, moments, and rough trims. Build the visible edit as OpenChatCut timeline items. Do not treat raw source inspection as timeline verification or as permission to produce the edited video elsewhere.
- For source-frame inspection: call `view_asset_frames({"assetId":"...","sourceTimesMs":[...]})` after `read_project({"view":"assets"})` confirms the asset id/type. Prefer this over asking the user to reattach the file.
- For local-only visual verification: upload/register cloud-readable media before relying on connector visual proof.
- For no-source validation: confirm the tool manifest exposed the parameters you used, then record the visible proof in the trace log.

When talking about seconds, verify the fps from `read_project` or use adapter tools that resolve fps internally.

When reporting a timeline item location, use only the latest `read_project` structure for track alias, item id, start, duration, and asset id. Do not report planned/default tracks or tool-call intent as verified placement.

Do not treat a command-line JSON response alone as sufficient when the user asks whether the editor reflects the result. Use the editor URL or visual proof when practical.

If verification fails, classify the gap before changing tools:

- tool description or schema was insufficient
- skill instructions were missing a step
- `read_project` did not expose enough state
- editor authorization did not complete
- media/transcription pipeline failed
- cloud render/editor observation was blocked
