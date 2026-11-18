# Optional workflow: generate an asset with the official Kling MCP plugin, then import and edit it in OpenChatCut

> Status: **documentation of an optional external-agent workflow**. Proposed in
> [issue #270](https://github.com/0xsline/OpenChatCut/issues/270) by **Wlain**,
> who asked that the OpenChatCut side be independently verified before this is
> documented as working. This page separates what was **verified** against a
> running OpenChatCut dev server from what **remains untested** (the Kling side
> and the combined workflow on a real host).

## Verified (OpenChatCut side)

All OpenChatCut-side claims below were tested on 2026-11-19 against a local
dev server at `http://localhost:5199` (isolated dev profile), using the live
MCP endpoint and the app's own upload routes. No Kling service, account, or
package was used.

### 1. An externally-generated video file can be imported into a project

Three documented import paths exist; the first two were exercised end-to-end:

**A. HTTP upload into the media store (verified).** A small `mp4` generated
with ffmpeg (`testsrc`, 320×240, 2 s) was POSTed to the app's upload endpoint:

```text
POST http://localhost:5199/upload?name=kling-demo.mp4&assetId=kling-demo
Content-Type: video/mp4
Origin: http://localhost:5199            # loopback same-origin write
Sec-Fetch-Site: none
```

Response `200`:

```json
{"path":"/media/uploads/kling-demo.mp4","bytes":31762,
 "contentHash":"3266b46e…e915a","fileKey":"uploads/kling-demo.mp4",
 "assetId":"kling-demo","created":true}
```

The file then appeared in `GET /upload/list`, was served back byte-identical by
`GET /media/uploads/kling-demo.mp4`, and ffmpeg extracted a still frame from the
served bytes. This is the same store the editor's media bin reads
(`server/plugins/upload-routes.ts`, `server/plugins/upload-route-write.ts`).
Writes are gated to loopback + same-origin browsers or the MCP handoff token
(`server/project-store-http-auth.ts`, `server/plugins/request-shape-gate.ts`).

**B. Agent import via MCP into a project (verified).** Using the live MCP
endpoint, a headless session did:

1. `create_project` → project id returned
2. `target_project` (offline binding)
3. `begin_edit_session` with `approvalMode: "auto"` → `editSessionId`
4. `import_asset` with `{ path: "/tmp/…mp4", editSessionId }` →

```json
{"ok":true,"imported":[{"id":"d6d93663-…","name":"kling-demo.mp4",
  "kind":"video","src":"/media/uploads/0eb3da26-….mp4"}],
 "duplicateCount":0}
```

5. `review_edit_session` → `"status":"applied"` (`operationCount: 1`,
   `appliedOperationCount: 1`)

The applied project document in the project store (SQLite `kv` table,
`project:<id>`) then contained the asset in `assets[]` with
`"name":"kling-demo.mp4"`, `"kind":"video"`, the uploaded `src`, and the same
content hash as the uploaded bytes — i.e. the media bin's persisted asset
references the imported file.

**C. URL import (present in code, not exercised).** `download_media`
(fetch a public URL into the pool) and `push_asset` (register a public media
URL) exist as agent tools (`src/agent/tools/schemas/stock-tools.ts`), and the
server exposes `POST /api/import-url`. These are browser/editor-bound tools and
were not run in the headless verification.

### 2. The host can run the Kling plugin and OpenChatCut's MCP server side by side

- OpenChatCut's endpoint is a standard **MCP Streamable HTTP** server:
  `http://localhost:5199/api/external-mcp/mcp` (`.mcp.json` in this repo; served
  by `server/plugins/external-agent.ts` → `server/external-agent/mcp.ts`).
  `initialize` succeeded over plain HTTP with `Accept: application/json,
  text/event-stream` and returned `serverInfo: {name:"openchatcut",
  version:"1.0.0"}`; the endpoint is authenticated with a bearer token and is a
  separate process/path from any generation plugin, so coexisting MCP servers
  are independent clients of the same host.
- Tool names do not collide. The live `tools/list` returned 45 OpenChatCut
  tools — e.g. `begin_edit_session`, `read_timeline`, `import_asset`,
  `import_assets`, `import_folder`, `browse_local_media`, `edit_item`,
  `add_audio`, `read_project`, `export_video`, `openchatcut_status` (the last
  one carries an explicit `openchatcut-` prefix). The official Kling plugin's
  tools are `kling-ai-generate-image` and `kling-ai-generate-video`
  (from the plugin's public README, read-only fetch). No name overlap exists,
  so a host's merged tool list stays unambiguous.
- Nothing in OpenChatCut serializes or blocks other MCP servers; the endpoint
  is plain HTTP served by the Vite dev server.

### 3. Kling references cited in issue #270 exist (read-only checks)

| Reference | Status |
| --- | --- |
| `github.com/klingai-tech/claude-plugin` | Exists, public, not archived (pushed 2026-11-18) |
| `github.com/klingai-tech/claude-plugin-cn` | Exists, public, not archived (pushed 2026-11-18) |
| `https://kling.ai/mcp/plugin` | Reachable; HTTP 401 without a Kling session (OAuth-gated) |
| `https://klingai.com/mcp/plugin` | Reachable; HTTP 401 without a Kling session |
| `https://kling.ai/app/mcp/guide` | Reachable; HTTP 200 |
| npm `@klingai/plugin-global` | Exists, v1.0.5 (metadata only) |
| npm `@klingai/plugin-cn` | Exists, v1.0.5 (metadata only) |
| npm `@klingai/cli-global` | Exists, v0.2.3 (metadata only) |
| npm `@klingai/cli-cn` | Exists, v0.2.3 (metadata only) |

None were installed, run, or called. The public plugin repositories contain
client/configuration material only, consistent with the reporter's note that
they do not establish that Kling's hosted backend is open source.

## Untested (Kling side and the combined workflow) — do not treat as verified

- **Kling OAuth, generation, and regional credits/billing** — requires the
  user's regional Kling account; OpenChatCut's maintainers and this
  verification did not use any Kling account, spend credits, or call Kling
  APIs. The reporter has not tested these either.
- **The actual combined workflow on a real host** (e.g. Claude Desktop or
  Codex running both servers and actually generating then importing) was not
  run. The two halves work (Kling per its own docs; OpenChatCut per the
  verification above), but no single end-to-end generation→import→export run
  was performed by anyone at the time of writing.
- **Kling output format assumptions** — any file/URL the Kling plugin returns
  must be a supported media file on the machine running OpenChatCut. `import_asset`
  runs locally, so the generated file must be on that machine (desktop default;
  browser sessions additionally require the `AGENT_IMPORT_ROOTS` allowlist).

## Suggested workflow (verbatim steps)

1. In an MCP-capable host, add **both** servers: the Kling official plugin
   (`kling-ai`, remote)
   and OpenChatCut (`openchatcut`, `http://localhost:5199/api/external-mcp/mcp`
   with bearer token).
2. Use the Kling tools (`kling-ai-generate-video` / `kling-ai-generate-image`)
   to produce the asset in the user's Kling workspace (their account/billing).
3. Bring the asset into OpenChatCut:
   - generated as a local file → call `import_asset` (verified above), or
   - generated as a public URL → `download_media` / `POST /api/import-url`, or
   - save the file and upload it in the OpenChatCut editor UI.
4. Edit the project through OpenChatCut's MCP tools
   (`begin_edit_session` → draft edits → `review_edit_session`; see
   `skills/openchatcut/references/editing-workflow.md`).
5. Export from the editor UI. A headless `export_video` MCP tool exists in
   open PR #244 and is not yet part of upstream `main`; until it merges, finish
   the render in the editor (or via the browser-bound render tools).

## Notes

- Credit for the proposal: **Wlain** (issue #270). This page is a
  documentation-only contribution; it implies no partnership with or
  endorsement by Kling AI, and no affiliation with the reporter (who has
  disclosed promoting Kling AI).
- Kling generation consumes the applicable region's personal workspace
  credits; it is a separate service, credential, and billing path from
  OpenChatCut and from Fal.ai.