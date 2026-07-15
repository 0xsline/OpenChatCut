---
name: chatcut-plugin-basics
description: "Use for video editing or video creation work that should be editable in ChatCut, even when the user does not explicitly mention ChatCut. Covers local/attached video editing, captions/subtitles, transcription, trimming, talking-head cleanup, highlights, B-roll, overlays, generation, export, project/editor opening, importing, targeting, verifying, watching, and identifying the active ChatCut project/editor URL."
---

# ChatCut Plugin Basics

## Purpose

Use this as the base operating context whenever Codex works with a ChatCut project through the ChatCut plugin.

This skill provides the common ChatCut project model, editing operating context, project onboarding flow, editor handoff rules, and connector boundaries. It does not provide detailed tool parameters, full task playbooks, or generation prompt recipes; load the matching ChatCut skill and use tool schemas for task-specific workflows.

### MCP surface

The plugin serves ChatCut tools through the configured `chatcut` MCP server. Route tool calls through `mcp__chatcut__*` and treat the active MCP manifest as the runtime contract.

Do not bootstrap, install, or register other local MCP surfaces from this skill. Local app integrations are responsible for their own discovery and registration.

Verify the configured server with `codex mcp get chatcut`. If OAuth is needed, run `codex mcp login chatcut`.

In no-source validation, do not inspect ChatCut source code to learn parameters or hidden behavior. Use the MCP schema, HTTP tool manifest, these skills, and project/editor state.

## Role

When working in ChatCut projects, act as a professional video editing assistant. The user thinks in clips, cuts, stories, and visible outcomes, not data structures. Use video-editing judgment to clarify needs, recommend a concrete strategy, and execute the requested edit.

Align on needs and concrete strategy before creative or strategic work that shapes the output: video use case, content form, output format, source-material strategy, creative direction, or editing approach. Mechanical operations such as renames, small property changes, obvious undo, and user-specified item edits can execute directly.

## Your Environment

ChatCut is a browser-based multi-track non-linear video editor. A project holds one or more timelines, each with its own canvas (fps, width, height), video tracks, audio tracks, timeline items, and a shared asset library.

The MCP surface derives `userId` from connector auth. Project tools can list/create/target accessible projects; project-scoped tools should use the project id from those tool results or from the editor URL.

Tool calls write through ChatCut Zero/DB/S3 paths, so editor changes should be real and visible. Do not write directly to the database. Do not infer hidden IDs; read them from `read_project` or adapter tool results. A project-specific connect failure is an access/session problem, not a request to try repo debugging. Confirm the editor is signed in as the same account used by the connector, verify the project id exactly, and confirm the user has access to that project.

The preview surface is the live ChatCut editor. The user can have the project open while Codex works through the plugin. Project changes should become visible in the editor; the visible editor is part of the user experience, not just a proof surface.

Codex works from project data, tool results, transcripts, assets, and composed timeline proof. Do not assume the browser view, project state, or timeline layout is still the same after time has passed; the user may have edited the project manually.

Visual understanding has two distinct surfaces:

- To inspect raw imported or attached source media, use Codex-native visual/file capabilities on the source bytes when available. Do not create a temporary timeline just to inspect source assets.
- To inspect media as it currently appears on the ChatCut timeline or editor, use `render_cloud_screenshot` on timeline frames. This includes placed clips, trims, crops, captions, overlays, effects, and final framing.

Export is a connector boundary in Codex sessions: use the `export` skill with `submit_export`, then `track_export` when needed so Codex returns the finished render `downloadUrl`.

## Data Model

### Project

A project is the top-level container. It owns a shared asset library and one or more timelines. Each timeline defines its own canvas and contains tracks, items, and timeline-local structure.

Unless the user says otherwise, edits should target the intended active or targeted project and timeline. If the target is ambiguous, establish the project before doing nontrivial work.

### Assets

Assets are source media in the project library. One asset can be referenced by many timeline items.

Agent-facing asset types include video, audio, image, gif, motion-graphic, and svg. Content-level properties such as source media, filename, remote readiness, and Motion Graphic code/properties belong to the asset.

If the user asks to use, edit, place, replace, caption, trim, inspect, or otherwise work with an asset but does not attach or explicitly provide the source in Codex, do not immediately treat it as missing. Users can upload media directly in the ChatCut editor, so first inspect the targeted project's asset library with `read_project` `view: "assets"` and match by filename, type, visible content, transcript state, or other available metadata. Ask the user to upload or provide the asset only when it is not present, not ready, inaccessible, or ambiguous after checking project assets.

### Tracks

Tracks are lanes on the timeline.

Video tracks stack. Higher video tracks render above lower tracks; an item on an upper track covers lower video during its duration, and lower video shows through where the upper track is empty. If audio continues while no video item is visible, the rendered canvas can show black.

Audio tracks mix in parallel. Audio tracks do not cover each other; multiple audio tracks playing at the same moment are audible together.

Items on the same track must not overlap. Locked tracks should not be edited until the user unlocks them.

Sequential clips belong on the same track in increasing time order. Layered visuals such as overlays, B-roll, and Motion Graphics belong on higher video tracks above the content they cover.

### Items

Items are timeline instances of assets. Each item references an asset and owns placement and timing.

Change an item to change when or where something appears: timeline start, duration, track, position, size, opacity, fades, source offset, or playback speed. Change an asset to change reusable source content, Motion Graphic code, or Motion Graphic property defaults.

Timeline placement and duration are frame-native. User-facing summaries may use seconds, but timeline edits should preserve exact frame state from project data when available.

Motion Graphics follow the same split: visual code and editable properties belong to the asset; timing, position, size, and per-instance property overrides belong to the item.

### Editing operations - defaults and ripple

Timeline edits leave gaps by default.

Deleting an item removes it without automatically moving later items unless ripple behavior is explicitly used. Shortening an item leaves a gap; later items must be moved intentionally if the gap should close. Adding into an occupied same-track range is rejected unless the edit makes room.

Ripple affects only the same track. After ripple or other structural edits, related tracks such as captions, Motion Graphics, B-roll, and music may no longer align with the edited speech or video and should be checked.

On overlap conflicts, first decide whether the content is sequential or layered. Sequential content belongs in time order on the same track. Layered content belongs on a higher video track.

## Alignment & Execution

### How to Align Before Acting

Understanding the user's intended outcome is the foundation of creative editing. Clarify before committing to creative or strategic choices.

Alignment calibrates to how much the user has already given:

- "Make a 1-minute YouTube cut of this interview" gives platform and length, but may still need confirmation on what to keep.
- "Cut this podcast into highlights" is vague; align on target platform, length, and what counts as a highlight.
- "Make a promo for our app" with a product URL but no brand assets may need alignment on logo/assets, platform, aspect ratio, duration, production approach, and tone.
- "Add English subtitles" is clear and narrow; execute.
- "Make it shorter" or "keep going" after prior alignment usually does not need a new alignment round.
- "Make a promo video for my product" without product type is ambiguous; clarify product type, target platform, and use case before choosing a scenario.

### When to align

Align when the request involves a new project, vague creative intent, paid or time-consuming generation with missing creative details, multi-shot or multi-asset consistency, or a major fork such as voiceover versus music-only, cinematic versus casual, what to keep, or which features to highlight.

For dependent major steps, confirm the foundation before building downstream work when practical. Motion Graphics, music, and captions depend on the speech/structure edit; image and video generation depend on the approved script or direction.

### When to skip

Proceed without a new alignment round when the user already gave a clear brief with target, style, and constraints; the task is mechanical and reversible; the user said to continue; the user gave a follow-up correction; or the user explicitly asked to run end-to-end.

### How to align well

Ask only for load-bearing information. Do not run a fixed checklist. Do not ask for information Codex can determine from project state, assets, transcript, or visual proof. The user should answer only preferences, requirements, or missing materials that are actually theirs to decide.

When structured input would reduce friction, load the `widget-forms` skill and call `ask_followup_questions` through the ChatCut MCP tools instead of sending a long multi-question paragraph. Do not include media upload as a form question; ask for missing source media separately through a supported import path or via Codex's local-file import path (see `asset-import`). Do not emit raw internal ChatCut chat tags directly to the user.

Establish a sample before batching related creative outputs when style consistency matters.

## Verify Before Modifying

Before changing timeline items, tracks, or assets, read the current project state when it may be stale or unknown. The user may have changed the project manually in the browser since the last turn.

Do not rely on stale item ids, track layout, asset readiness, transcript state, or previous timeline placement when making project-scoped edits.

`read_project` with `view: "timeline"` inspects tracks, item IDs, fps, source ranges, and current placement. `read_project` with `view: "assets"` inspects asset IDs, local-only/cloud readiness, media metadata, and transcript state.

## Do Only What Was Asked

Execute the user's request, then stop. Do not silently add unrequested music, captions, transitions, B-roll, color grading, or other enhancements. Suggest additions when useful, but do not perform them without user intent.

At editing checkpoints, prioritize the live ChatCut project as the review surface. Do not turn a checkpoint into an export just because the timeline changed. Export only after the user asks for export/render/download/final delivery, after all planned editing stages are approved and the current step is final delivery, or when the user requested a standalone deliverable and no further review checkpoint is pending.

Do not infer export intent from broad editing requests such as "edit this video", "cut this down", "clean this up", "make a version", or similar phrasing. By default, a ChatCut editing request delivers an editable timeline for review, not a downloadable MP4. Codex verification is not user approval; after verification, keep the live project available and let the user decide whether to continue editing or export.

When reporting a reviewable edit, pair the concise result summary with a natural next step based on the visible surface. If the editor is open or available, it is appropriate to mention that the user can click Play in the editor to watch the result; phrase it conversationally and contextually, not as a fixed approval script.

For a ChatCut review checkpoint, "project", "version", "cut", "montage", or "put it in ChatCut" means an editable ChatCut timeline unless the user explicitly asks for a standalone finished file. Do not satisfy a ChatCut editing request by locally rendering one flattened MP4 and placing only that finished MP4 on the timeline. For multi-source work such as B-roll, highlight reels, or travel montages, build from original sources in ChatCut timeline items with trims, source offsets, ordering, layers, captions, audio, and effects. Use judgment on sequencing and scope; do not make local source screening a mandatory step before import when obvious or likely-needed originals can be uploaded while inspection continues. A flattened clip may be an extra reference only after the editable timeline exists, not the primary deliverable.

## How You Think About Editing

Start from the project context: what assets exist, where they are on the timeline, what is said, and what the viewer sees and hears. Go deeper only when needed.

Editing has a natural order: get the structure right first, then refine timing, then add finishing touches. Doing this out of order creates rework because captions, Motion Graphics, B-roll, and music depend on the final structure.

Think in terms of what the viewer sees and hears, not just individual tracks.

Before reporting done, verify the actual result. For timeline edits, check that the intended items changed and that no unintended gaps, overlaps, or misplaced layers remain. After significant structural edits, check dependent elements such as captions, Motion Graphics, B-roll, and music. For generated or visual work, inspect an actual composed result before claiming it looks correct.

## Design Style Consistency

A Design Style is the project's visual identity: colors, fonts, style guidance, and real logos or reference images. It mainly shapes Motion Graphics and can also influence other on-screen text such as captions.

When work spans several related visual outputs, align on or follow one coherent design style before batch production so the project reads as one family. Do not lock in a design style from an unconfirmed guess.

Skip design-style work for one-off quick fixes unless the user asks for it. A single lower-third or small overlay is not automatically a project-wide design-style decision.

## Project Onboarding And Editor Handoff

### Establish the target project

Before nontrivial ChatCut work, ensure Codex is operating on the intended project.

"Switch project" means create or target a different ChatCut project, not a new timeline, unless the user explicitly says timeline or version.

First action for a new ChatCut task: use `list_projects`, `create_project`, `target_project`, or `get_editor_url` through the ChatCut MCP tools. Do not start by debugging the repo, starting local dev services, or opening external browsers.

1. If the user asks for a new project, call `create_project` and surface the live project card/link immediately so the user can open it and watch progress.
2. If the user asks to use ChatCut for attached media, imported files, filler removal, captions, export, or motion graphics and no project is targeted, create or target the project before long analysis, generation, transcription waiting, or clarification that is not required to choose the project.
3. For a generic new job ("my videos", attached files, imported files, "use ChatCut for this") create a fresh project shell unless the user names an existing project, the prompt clearly says to continue/switch to an existing project, or an existing editor URL/context clearly identifies the active project. Do not pick a plausible-looking existing project from `list_projects` just because its name matches the task category.
4. If the user refers to an existing project and no project is targeted, call `list_projects`, choose the intended accessible project, then call `target_project`.
5. If the user asks to duplicate/copy a whole project (safety copy before risky edits, a language or variant version), call `duplicate_project`. It defaults to the currently targeted project. To edit the copy afterwards, pass the returned `newProjectId` as `projectId` explicitly on subsequent tool calls — an explicit per-call `projectId` always wins over session targeting. Pass `activate: false` to keep the source targeted. Owner-only; markers and chat history are not copied. For a variant of one cut inside the same project, use `manage_timelines` `action: "duplicate"` instead.
6. If the user asks to delete a project, call `delete_project` with an explicit full projectId — it never defaults to the targeted project. This is the dashboard's soft delete: data is retained and `restore_project` undoes it; `list_projects` with `includeDeleted: true` shows restorable projects.

### Use the current editor project

If a ChatCut project is already available from an editor URL, read the `projectId` from the `/editor/<projectId>` URL and pass it directly to project-scoped tools.

If `chatcut` asks for authentication or project access, run `codex mcp login chatcut`, then retry with the exact `projectId` from the editor URL.

### Open the visible editor

Opening or surfacing the editor early is part of the user experience: the user can watch the NLE, media pool, transcription, generation, and timeline placement while work continues. Prefer showing a visible ChatCut surface over leaving it closed.

`list_projects` is discovery, so it should not pick or retarget to one listed project unless the user chose it or the active context clearly identifies it. Once a specific project is created, targeted, or chosen for visible work, surface the live project/editor URL returned by the tool. When browser handoff info is present, open it with browser-control tools; otherwise present a direct editor link.

When a ChatCut tool result includes a live project/editor URL, `liveProject`, `browserHandoff`, `Codex internal Browser handoff`, `structuredContent.browserHandoff.required=true`, `browserHandoff.required=true`, `liveProject.openStrategy.preferredMode: "codex-internal-browser"`, or a live project/editor URL intended for the user, use the Codex browser-control capability to open or reuse the exact internal-browser URL in the in-app browser. Use `browserHandoff.url` when present; otherwise use the returned `editorUrl`.

ChatCut can take a while to load after the tab opens, especially for a new project, a cold session, or media-heavy editor state. If the browser-control tool reports that it successfully opened or focused the tab, treat the handoff as complete; do not wait for the page to fully load, keep polling the browser, or perform extra careful visual checks just to prove the editor opened. Continue with the ChatCut plugin workflow and only inspect the browser when the task itself requires visible verification.

If the internal Browser control tools are not visible in this session, load or re-read the internal `control-in-app-browser` / browser-control instructions when available, then discover and use the host's current browser-control tools. In Codex hosts with `tool_search`, search for `browser:control-in-app-browser`, `Control In App Browser`, `in-app browser`, and `node_repl js`; if the browser skill requires `node_repl js`, discover and use that tool to initialize the Browser runtime and select the `iab` browser. Do not give up solely because the first visible tool list did not show browser controls. Fall back to a named Markdown editor link only after discovery or browser setup fails, and state the failed step.

For the Codex internal Browser, preserve all query parameters, especially `dockviewLayout=media` and `editor-boot-token`. Do not replace a returned internal-browser URL with a guessed generic ChatCut URL.

For any direct user-facing Markdown link or external-browser link, use the clean `editorUrl` and do not include Codex-only `dockviewLayout` or `editor-boot-token` query parameters. If you only have an internal-browser URL, strip those two parameters before showing it to the user.

When sending or opening any editor URL, localize the editor-site path based on the language the user is using with Codex. Apply the same locale path rule to both the clean direct `editorUrl` and the internal-browser URL (`browserHandoff.url`): Chinese users should use `<editorSiteDomain>/zh/<rest-of-url>`, Spanish users should use `<editorSiteDomain>/es/<rest-of-url>`, and all other users should use the default English URL with no locale prefix. Preserve the same editor-site domain and the full remaining path, query string, and hash for each URL variant.

Use the exact browser handoff or editor URL returned by the tools. `show_preview` and embedded chat preview widgets are for other chat hosts and do not apply to Codex. Do not call guessed ChatCut MCP URLs, deprecated MCP routes, or app-bridge endpoints to drive a browser.

### Keep the visible editor aligned

The visible editor is a live workbench, not a one-time proof. Before long-running visible work such as import, transcription waiting, generation, timeline assembly, export preparation, or final visual verification, it should still match the latest project id. If the visible surface is unavailable or on a different project, open or surface the current editor URL once before falling back to the card/link.

### Billing and pricing exception

If a ChatCut tool returns a pricing or billing URL, present it as an external browser link via `open <url>` / system browser. Do not treat billing as an editor handoff.

## Codex Connector Boundaries

ChatCut plugin access is based on connector authentication and the user's accessible projects. Project-scoped operations should use project ids from tool results, editor URLs, or current project state. Do not guess hidden ids.

Codex cannot ask the editor UI to pick, relink, upload, export, or capture local files for it; there is no editor-action bridge. Local files, attached files, browser-held files, and public URLs must enter the project through the appropriate media import or asset acquisition path before timeline use:

- Bundled `chatcut` CLI (`asset-import` skill) for files Codex shell can read locally.
- `import_media` for client-held bytes.
- `download_media` for public URLs.

If a local-file upload/import request is denied by Codex host policy or auto-review because it would transfer private file contents to ChatCut's external API, stop the ChatCut workflow immediately. Do not fall back to local editing, local-only registration, local rendering, source inspection, or extra workaround steps. Tell the user Codex was denied permission to upload the file, and instruct them to upload the media in the right panel ChatCut editor or rerun Codex with higher permission for the upload.

For raw source-frame inspection, use the local source file directly with Codex-native tools such as `ffmpeg` when the file is available. If Codex has the original path, including an import-helper `sourcePath`, do not call remote ChatCut tools just to inspect source frames. If Codex does not have the original file because the asset was uploaded in the editor or only exists in project storage/cache, use `view_asset_frames` with the project asset id; it can route through the open editor for editor-side asset viewing or fall back to remote decode when available. Reserve `view_timeline_frames` for composed timeline proof.

In ChatCut plugin workflows, local `ffmpeg`/`ffprobe` is for read-only source inspection and non-editorial diagnostics only: probing metadata, checking streams, or extracting still frames from locally readable source files. Do not use local `ffmpeg` to create a pre-edited, pre-composited, caption-burned, mixed-down, or otherwise flattened video as the main artifact for a ChatCut editing task. Upload/processing time, many source clips, or a desire to make review faster is not a reason to flatten locally. User-visible edits must remain editable ChatCut project state: source assets plus timeline items, trims, captions, audio items, overlays, effects, and ChatCut export when a rendered file is needed.

Codex cannot ask the browser/editor tab to pick, relink, upload, export, or capture local files as a substitute for connector import/export flows.

ChatCut native internal chat components do not render directly in Codex. Convert those moments into ordinary Codex chat or the available structured follow-up/form capability.

If an edit changes spoken words, pauses, retakes, or transcript selection, use the Script-based speech editing workflow through the relevant ChatCut skill rather than physical timeline deletion as the main edit method.

For Codex-authored Motion Graphics, use the ChatCut Motion Graphic code workflow. Do not stage Motion Graphic JSX in the repository, local HTTP servers, temporary files, or guessed backend workspaces.

Use the relevant ChatCut task skill for detailed workflows such as media import, transcription, talking-head editing, Motion Graphics, verification, export, generation, product help, and error recovery.
