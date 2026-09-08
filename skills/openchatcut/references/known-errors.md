# OpenChatCut MCP recovery

## Connection refused

OpenChatCut is closed, the configured URL is stale, or desktop port 5199 fell
back to another port.

1. Start OpenChatCut.
2. Read the endpoint from **Settings → MCP** or the startup log.
3. Update the single `openchatcut` MCP entry.
4. Call `openchatcut_status` again.

## Projects exist but no editor is connected

Call `get_editor_url` for the intended project and have the user open it.
Project listing and creation can work without a live editor, while timeline
tools require the target project to be open.

## Tool missing

The editor registers project tools after its bridge connects. Open the target
project, call `openchatcut_status`, and refresh the MCP tool list.

## Stale edit session

Call `list_edit_sessions` before starting another session. For an entry marked
`orphaned: true`, call `recover_edit_session` with one of its `recoveryActions`:

- `resume` continues a draft only when its checkpoint still matches the project.
- `discard` removes the abandoned draft without changing the live project.

An online owner must finish or discard its own session. Terminal `stale`,
`cancelled`, and `failed` sessions cannot be resumed; begin a fresh session.
An auto session stays auto and does not fall back to manual review.

## Proposal awaiting review

The draft is ready, but manual approval is still pending in OpenChatCut. Keep
polling `get_edit_session` only when the client needs the final state. Report
`applied`, `rejected`, or `discarded` exactly as returned.

## Skill baseline is newer

Update the installed skill, then re-read its files:

```bash
npx skills update openchatcut
```

If the source alias is unavailable:

```bash
npx skills add 0xsline/OpenChatCut --skill openchatcut
```
