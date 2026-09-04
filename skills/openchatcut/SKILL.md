---
name: openchatcut
description: Connect an MCP-capable coding agent to OpenChatCut and edit local video projects. Use when the user asks to install, connect, or set up OpenChatCut; inspect or edit an OpenChatCut project; work with its timeline, transcript, captions, media, generation, motion graphics, audio, color, or export tools; or recover from an OpenChatCut MCP error.
---

# OpenChatCut

OpenChatCut is a local-first, agent-native video editor. This skill is the
single external entry point; specialized editing guidance remains inside the
running editor and is loaded on demand with `load_skill`.

## Route the task

- Install, connect, or diagnose the MCP server: read
  `references/getting-started.md`.
- Inspect or modify a project: read `references/editing-workflow.md`.
- Recover from a failed tool call, stale session, or missing editor:
  read `references/known-errors.md`.

## Essentials

1. Start OpenChatCut before connecting. The default MCP endpoint is
   `http://localhost:5199/api/external-mcp/mcp`.
2. Call `openchatcut_status`, then `list_projects`. Select a project only when
   the user names it or the current context identifies it.
3. Call `load_skill` before specialized work. It is read-only and requires
   neither `begin_edit_session` nor `editSessionId`; available names and support
   files come from the live MCP tool description.
   With progressive exposure enabled, this call reveals the skill's referenced
   tools and emits `tools/list_changed`; refresh the list before continuing.
4. Before project reads or edits, call `begin_edit_session`. Keep its
   `editSessionId` and pass it to every draft-safe editor tool.
5. If `begin_edit_session` reports an active session, call `list_edit_sessions`.
   An orphaned session may be resumed or discarded with `recover_edit_session`
   using an action listed in `recoveryActions`; an online owner must finish or
   discard its own session.
6. Use `approvalMode: "manual"` unless the user explicitly asks for unattended
   application. In manual mode, the user approves the complete proposal in
   OpenChatCut. In auto mode, `review_edit_session` applies the complete draft.
7. Finish with `review_edit_session`. Report success only after
   `get_edit_session` returns `applied`.

## Skill version

`2026-09-04.1`

The OpenChatCut MCP server announces its required skill baseline. If the server
baseline is newer, run:

```bash
npx skills update openchatcut
```

Fallback command:

```bash
npx skills add 0xsline/OpenChatCut --skill openchatcut
```
