import type { BrowserWindow } from 'electron';
import { EDITOR_TOKEN_HEADER, editorApiToken, externalMcpToken } from '../server/editor-auth.ts';

const RENDER_DRAIN_MS = 500;

export async function runDesktopSmokeProbe(
  origin: string,
  win: BrowserWindow,
  render: boolean,
): Promise<void> {
  const res = await fetch(`${origin}/api/keys`, {
    headers: { [EDITOR_TOKEN_HEADER]: editorApiToken() },
  });
  if (!res.ok) throw new Error(`/api/keys → HTTP ${res.status}`);
  const mcp = await fetch(`${origin}/api/external-mcp/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${externalMcpToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'desktop-smoke', version: '1' },
      },
    }),
  });
  if (!mcp.ok || !(await mcp.text()).includes('"name":"openchatcut"')) {
    throw new Error(`/api/external-mcp/mcp → HTTP ${mcp.status}`);
  }
  console.log('[smoke] external MCP endpoint ok');
  const pickerType = await win.webContents.executeJavaScript(
    'typeof window.openChatCutDesktop?.selectDirectory',
  ) as unknown;
  if (pickerType !== 'function') throw new Error('desktop directory picker preload is unavailable');
  console.log('[smoke] desktop directory picker preload ok');
  const updaterType = await win.webContents.executeJavaScript(
    'typeof window.openChatCutDesktop?.updates?.check',
  ) as unknown;
  if (updaterType !== 'function') throw new Error('desktop updater preload is unavailable');
  console.log('[smoke] desktop updater preload ok');
  const inference = await win.webContents.executeJavaScript(
    'window.openChatCutDesktop?.inference?.getCapabilities()',
  ) as {
    version?: unknown;
    asr?: { available?: unknown };
    semantic?: { available?: unknown };
    clap?: { available?: unknown };
    rhythm?: { available?: unknown };
  } | null;
  if (inference?.version !== 3
    || typeof inference.asr?.available !== 'boolean'
    || typeof inference.semantic?.available !== 'boolean'
    || typeof inference.clap?.available !== 'boolean'
    || typeof inference.rhythm?.available !== 'boolean') {
    throw new Error('desktop native inference preload is unavailable');
  }
  console.log('[smoke] desktop native inference preload ok');
  if (!render) return;
  const state = { fps: 30, width: 640, height: 360, items: [], selectedId: null };
  const response = await fetch(`${origin}/render-still`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      [EDITOR_TOKEN_HEADER]: editorApiToken(),
    },
    body: JSON.stringify({ state, frames: [0] }),
  });
  if (!response.ok) {
    throw new Error(`/render-still → HTTP ${response.status}: ${await response.text()}`);
  }
  const rendered = (await response.json()) as { frames?: Array<{ base64?: string }> };
  if (!rendered.frames?.[0]?.base64) throw new Error('/render-still returned no frame');
  console.log(`[smoke] render-still ok, base64 ${rendered.frames[0].base64.length}B`);
  // Remotion can emit late DevTools protocol callbacks after the response.
  await new Promise((resolve) => setTimeout(resolve, RENDER_DRAIN_MS));
}
