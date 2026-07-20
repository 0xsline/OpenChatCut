# OpenChatCut UI & Features

## Project Entry & Dashboard

The app opens on a project dashboard. If there are no projects, a sample project may be created on first run.

- **New project** — Create an empty project and open the editor.
- **Scenario chips/cards** — In a new or empty AI conversation, users can pick workflow starters (inserts a starter prompt into the composer):
  - **Seedance / AI video** — Generate AI video clips from a text description (needs a configured video provider key).
  - **App Promo** — Create a polished promotional video for an app or website.
  - **URL to Ad Video** — Paste a product link to generate a short ad-style video (needs web + video providers as configured).
  - **Motion Graphics** — Generate animated visual elements from text or image references.
  - **Talking Head Editing** — Upload talking head footage; the agent picks the best takes, cuts filler words, tightens pacing, and adds motion graphics.
  - **Explainer Video** — Provide a topic (and optionally your own media); the agent creates a complete explainer video with AI narration, visuals, and background music.

## Editor Layout

The editor has five main areas:

### AI Panel

The conversation with the AI assistant. Users can reference timeline items and assets using @ mentions in the input box to tell the AI exactly what to modify. Files can be attached as context for the AI.

At the bottom of the panel:

- **Mode switcher** — Two modes:
  - **Agent** — Full AI editing assistant. The AI reads your message, understands context, and performs editing tasks.
  - **Ask** — Q&A only; does not edit the timeline.
- **Agent Settings** — Open from the controls next to the mode selector. Settings include:
  - **Thinking Mode** — Turn the agent's extra reasoning on or off.
  - **Motion Graphics Quality** — Choose Speed, Balance, or Quality for motion graphics generation.
  - **Auto-apply proposals** — When on, ordinary timeline proposals may apply automatically; generation / export tools still go through confirmation (skill guard).
- **Proposal / confirmation card** — Structural edits and generation tools may show a review card (apply / reject) before changes land.
- **+ button** — Upload reference files (images, videos, etc.) to include in your message.
- **Skills / 技能 (book icon)** — Open the Skills picker below the chat input. Users can choose a preset Skill or one of their saved Skills to guide the AI with a reusable workflow for the current message. Saved Skills are user-owned and can be reused across projects. The picker also includes **Save this editing process as a Skill**, which inserts a prompt asking the AI to help capture the current workflow.
- **Selection button** — Toggle selection mode. When active, the user can reference content by:
  - Clicking items on the timeline or in My Assets to reference specific clips/assets.
  - Dragging a box on the preview canvas to reference a screen region.
  - Clicking a point on the timeline ruler to reference a specific time.
  - Selecting text in the Transcript panel to reference a portion of speech.
    Selected references are added as @ mentions in the input box so the AI knows exactly what the user is referring to.
- **Send / Stop button** — Send a message or stop an in-progress task.

### Center — Preview

The video preview canvas. Shows a live preview of the timeline at the current playhead position. Supports playback controls below.

### My Assets, Library & Transcript Panels

Tabs that share one panel group (separate from the AI panel):

- **My Assets** (ZH: "素材库") — The user's media pool. Shows uploaded, recorded, imported, and generated media. Users can drag assets from here onto the timeline. The **Upload** button opens local file / folder import.
  - **Generation progress:** When AI generation tasks (video, image, music, etc.) are in progress, they appear in My Assets with a progress indicator. This is where users can check if a generation is still running or has completed.
  - **Generation failures:** If a generation fails, My Assets shows a failure status on the asset card. The user can ask the AI to regenerate.
  - **Bins:** Users can create bins/folders to organize assets.
- **Library** — Built-in presets/effects/assets that can be browsed separately from the user's own assets.
- **Templates** — Template browser when enabled.
- **Transcript** (ZH: "文字稿" / ES: "Transcripción") — A text-based editing panel for talking head / interview footage. Users edit the video by editing text:
  - Select and delete unwanted words/sentences to remove them from the timeline.
  - Drag text segments to reorder the video sequence.
  - While the agent edits, the result previews here live — deletions show struck through — and the user can fine-tune in this panel.
  - Transcript follows the active captions/source track. If no specific source track is set, it uses the first track with video or audio.

### Top Bar

From left to right:

- **Home icon** — Opens the project library/dashboard.
- **Project name** — Double-click (or edit control) to rename.
- **Undo / Redo** — Undo or redo editing actions.
- **Design style** — Brand colors/fonts for MG and captions.
- **Skin** — UI theme picker.
- **Versions** — Save and restore project snapshots.
- **Export history** — Recent exports.
- **Layout** — Toggle panel layout.
- **Export button** — Export timeline (video/audio/subtitles/XML depending on build). Motion graphics can also be baked / exported from clip menus when available.

### Playback Controls (above the timeline)

- **Split tool** (shortcut: C) — Split the clip at the playhead position.
- **Snapping toggle** (shortcut: Shift+M) — Enable/disable snap-to-grid when dragging items on the timeline.
- **Play / Pause** (shortcut: Space)
- **Time display** — Current position / total duration.
- **Zoom controls** — Zoom in/out on the timeline, plus "Zoom to Fit" to show the full timeline.
- **Aspect ratio** — Change the canvas dimensions. Presets: 16:9, 9:16, 1:1, 4:3, 3:4.
- **Captions** — Enable auto-captions and choose a caption style (e.g., Netflix, Minimal, TikTok, YouTube).
- **Fullscreen** (shortcut: `) — Enter fullscreen preview mode.

### Timeline (bottom)

A project can hold multiple timelines (sequences) — for example a long cut and a short promo. The active timeline is selected from a dropdown above the timeline ruler; switching the dropdown swaps the visible tracks and clips while the asset library stays shared.

The timeline shows all tracks and clips for the active timeline. Video tracks (V1, V2, ...) are on top; audio tracks (A1, A2, ...) are below. Users can:

- Drag clips to reposition them.
- Drag edges to trim clips.
- Use the playhead (yellow marker) to scrub through the video.
- **Mark In/Out zone** — Press **I** to mark the in point, **O** to mark the out point, **X** to clear the zone. The selected zone can be used when exporting to only export that portion of the video (choose "Zone" as the export range in the Export panel).

Each track has controls: visibility toggle (eye icon), audio toggle (speaker icon), and delete (trash icon).
