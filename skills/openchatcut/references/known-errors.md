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

Discard the stale session and begin a fresh one. An auto session stays auto; it
does not fall back to manual review.

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
