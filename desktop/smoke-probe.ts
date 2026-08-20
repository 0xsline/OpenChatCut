import type { BrowserWindow } from 'electron';
import { externalMcpToken } from '../server/editor-auth.ts';
import { runDesktopMcpRecoverySmoke } from './smoke-mcp-recovery.ts';

const RENDER_DRAIN_MS = 500;

export async function runDesktopSmokeProbe(
  origin: string,
  win: BrowserWindow,
  render: boolean,
): Promise<void> {
  const res = await fetch(`${origin}/api/keys`);
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
  if (process.env.CC_SMOKE_MCP_RECOVERY === '1') {
    await runDesktopMcpRecoverySmoke(origin, externalMcpToken());
  }
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
  // Editor bridge heartbeat (issue #86): the long poll is timer-driven, so
  // background throttling must be off or minimizing the window drops the
  // MCP bridge offline. Assert the RUNTIME value, not just the source flag.
  const throttlingDisabled = win.webContents.getBackgroundThrottling();
  if (throttlingDisabled !== false) {
    throw new Error(`background throttling is enabled (${String(throttlingDisabled)}); the MCP bridge heartbeat will stall in background windows`);
  }
  console.log('[smoke] background throttling disabled (bridge heartbeat safe)');
  const inference = await win.webContents.executeJavaScript(
    'window.openChatCutDesktop?.inference?.getCapabilities()',
  ) as {
    version?: unknown;
    asr?: { available?: unknown };
    semantic?: { available?: unknown };
    clap?: { available?: unknown };
    rhythm?: { available?: unknown };
    hardware?: {
      cpu?: { logicalCores?: unknown; totalMemoryBytes?: unknown };
      gpus?: unknown;
      hardwareAcceleration?: unknown;
    };
  } | null;
  if (inference?.version !== 3
    || typeof inference.asr?.available !== 'boolean'
    || typeof inference.semantic?.available !== 'boolean'
    || typeof inference.clap?.available !== 'boolean'
    || typeof inference.rhythm?.available !== 'boolean'
    || !Array.isArray(inference.hardware?.gpus)
    || typeof inference.hardware?.cpu?.logicalCores !== 'number'
    || typeof inference.hardware?.cpu?.totalMemoryBytes !== 'number'
    || typeof inference.hardware?.hardwareAcceleration !== 'boolean') {
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
      'Sec-Fetch-Site': 'same-origin',
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
