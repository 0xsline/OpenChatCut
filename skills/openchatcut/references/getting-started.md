# Connect OpenChatCut

Use this flow when the user says “set up OpenChatCut”, when the `openchatcut`
MCP server is missing, or when its endpoint cannot be reached.

## 1. Find the endpoint

The default endpoint is:

```text
http://localhost:5199/api/external-mcp/mcp
```

Start OpenChatCut first. If desktop port 5199 was occupied, use the endpoint
shown in OpenChatCut under **Settings → MCP** or in its startup log.

## 2. Register the MCP server

### Codex

Check the existing entry:

```bash
codex mcp get openchatcut
```

If it is missing, register it:

```bash
codex mcp add openchatcut \
  --url http://localhost:5199/api/external-mcp/mcp
```

If an existing URL is stale, replace only that entry:

```bash
codex mcp remove openchatcut
codex mcp add openchatcut \
  --url http://localhost:5199/api/external-mcp/mcp
```

### Claude Code

```bash
claude mcp add --transport http openchatcut \
  http://localhost:5199/api/external-mcp/mcp
```

For another client, register the endpoint as a Streamable HTTP MCP server.

## 3. Verify

When the MCP tools are available, call:

1. `openchatcut_status`
2. `list_projects`

Interpret the result:

- Editors listed: the live editor bridge is ready.
- Projects listed but no editor connected: project discovery works; open the
  intended project using its `editorUrl`.
- No projects: the connection works; ask whether to create a project.
- Connection error: follow `known-errors.md`.

Do not create or select a project just because one looks plausible.

## 4. Start the first task

Once the user has identified a project:

1. Call `target_project`.
2. Surface the URL returned by `get_editor_url`.
3. Follow `editing-workflow.md`.

## Remote endpoint

Localhost needs no token by default. When the user exposes OpenChatCut over a
network, use the URL and Bearer token they configured with
`OPENCHATCUT_EDITOR_URL` and `OPENCHATCUT_MCP_TOKEN`. Keep the token in the MCP
client's secret/environment configuration rather than writing it into a
repository.
