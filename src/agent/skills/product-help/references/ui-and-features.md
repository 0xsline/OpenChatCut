# ChatCut UI & Features

## Project Entry & Dashboard

After sign-in, ChatCut opens the editor. If the user already has projects, the most recently updated project opens with the project dashboard available. If the user has no projects, ChatCut creates an empty project and opens the editor.

- **New project** — In the project dashboard, users can click **New project** to create another empty project.
- **Scenario chips/cards** — In a new or empty AI conversation, users can pick workflow starters:
  - **Seedance 2.0** (Pro only) — Generate AI video clips from a text description.
  - **App Promo** — Create a polished promotional video for an app or website.
  - **URL to Ad Video** (Seedance 2.0, Pro only) — Paste a product link to generate a UGC-style short ad video.
  - **Motion Graphics** — Generate animated visual elements from text or image references.
  - **Talking Head Editing** — Upload talking head footage; the agent picks the best takes, cuts filler words, tightens pacing, and adds motion graphics.
  - **Explainer Video** — Provide a topic (and optionally your own media); the agent creates a complete explainer video with AI narration, visuals, and background music.
    Selecting a scenario inserts a starter prompt into the AI composer. The user can edit it before sending.

## Editor Layout

The editor has five main areas:

### AI Panel

The conversation with the AI assistant. Users can reference timeline items and assets using @ mentions in the input box to tell the AI exactly what to modify. Files can be attached as context for the AI.

At the bottom of the panel:

- **Mode switcher** — Two modes:
  - **Agent** — Full AI editing assistant. The AI reads your message, understands context, and performs editing tasks.
  - **Video Gen** — Direct video generation mode. Your input is sent straight to the video generation pipeline without AI conversation, which uses fewer credits.
- **Agent Settings** — Open from the controls next to the Agent mode selector. Settings include:
  - **Thinking Mode** — Turn the agent's extra reasoning on or off.
  - **Motion Graphics Quality** — Choose Speed, Balance, or Quality for motion graphics generation.
  - **Generation Auto-Allow** — Control whether repeated credit confirmation prompts can be skipped for Motion Graphics, Video Generation, and Image Generation in the current project. If a user chose "Allow all ... in this project" in a credit confirmation prompt, the matching switch is enabled here. To turn it off for this project, use **Agent Settings -> Generation Auto-Allow -> Motion Graphics / Video Generation / Image Generation**.
- **Generation confirmation card** — Before Motion Graphics, Video Generation, or Image Generation starts, the AI chat may show an approval card with **Allow**, **Allow all ... in this project**, **Deny**, and an adjustment field. It appears inline in the AI chat area near the composer. If the card is gone, it may have been answered, cancelled, or timed out; ask the user whether to retry or enable Auto-Allow from Agent Settings.
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

- **My Assets** (ZH: "素材库") — The user's media pool. Shows uploaded, recorded, imported, and generated media. Users can drag assets from here onto the timeline. The **Upload** button opens **Files...**, **Folder...**, and **From phone...** options.
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
- **Presence avatars** — Shows collaborators active in the project.
- **Project name** — Project owners can click the title text to rename. Non-owners can view the name but cannot rename it.
- **Share & members** — Button next to the project name for sharing the project and managing members.
- **Undo / Redo** — Undo or redo editing actions.
- **Workspace menu** — Show or hide panels: AI, My Assets, Library, Transcript, and Timeline. Also has **Reset to default** to restore the default layout.
- **Versions** — Save and restore project snapshots.
- **Export button** — Opens the export panel with five tabs:
  - **Video** — Export as MP4. Options: resolution (1080p / 720p / 480p), frame rate (24–60 fps), export range (full timeline or selected zone).
  - **Audio** — Export audio only as MP3.
  - **Graphics** — Export each motion graphic as a separate transparent ProRes 4444 `.mov` file (Pro only).
  - **Subtitles** — Export subtitles.
  - **XML** — Export an NLE XML file; it can also render motion graphics as separate ProRes 4444 files when included.
- **Credit balance** — Shows the user's current credit balance. Part of the user profile menu.
- **User profile menu** — Dropdown showing the user's email, current plan (Free or Pro) with credit balance, and an **Upgrade** button. Menu items include Language, Skin, Invite friend, Feedback, Keyboard shortcuts, Credits history, and Sign out. Subscription and payment actions live inside **Credits history**.

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
