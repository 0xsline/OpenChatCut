# Edit an OpenChatCut project

## Start with current state

1. Call `openchatcut_status`.
2. Call `list_projects` when the project is not already identified.
3. Call `target_project` with the selected project ID.
4. When specialized guidance applies, call `load_skill`; it requires no edit
   session or `editSessionId`.
5. Call `begin_edit_session` and keep the returned `editSessionId`.
6. Call `read_project` with that session ID before the first mutation.

Use `approvalMode: "manual"` by default. Use `"auto"` only when the user asks
for an unattended, atomic application.

## Load specialized guidance

Call `load_skill` after targeting the project and before specialized work. Common skill names include:

- `talking-head-guide`
- `transcription`
- `create-motion-graphics`
- `image-gen`
- `video-gen`
- `voice`
- `music`
- `shader-gen`
- `export`
- `verification`

Treat the live `load_skill` tool description as the current catalog. If a
loaded skill lists support files, request the relevant one with its `file`
argument.

## Apply edits

- Use IDs returned by `read_project`, discovery tools, or prior receipts.
- Keep every editor call in the same edit session.
- Re-read the project after a failed mutation or when the timeline may be
  stale.
- Use `view_timeline_frames`, `inspect_color`, or the verification skill after
  visual edits.
- Keep generation and other immediate side effects outside a proposal unless
  the exposed tool explicitly supports the draft session.

## Review and finish

1. Call `review_edit_session` after all draft edits are ready.
2. For manual mode, tell the user the proposal is ready inside OpenChatCut.
3. Poll `get_edit_session` when the client needs the final state.
4. Report completion only when the status is `applied`.
5. If the status is `rejected` or `discarded`, report that exact result.

Applied operations form one atomic undo step.
