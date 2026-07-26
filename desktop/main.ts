import './chdir-first.ts';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, type MenuItemConstructorOptions, type OpenDialogOptions } from 'electron';
import { startEmbeddedServer } from './embedded-server.ts';
import { preparePackagedRuntime } from './packaged-runtime.ts';
import { setKikiSessionBridge, KIKI_DEFAULT_UA } from '../server/kiki/session-bridge.ts';
import { solveGeetest } from '../server/kiki/geeked/solver.ts';

// Electron 主进程入口。dev 形态:esbuild 打到 desktop-dist/main.mjs,dist/ 在仓库根;
// 打包形态:dist/、remotion-bundle、chrome-headless-shell 走 extraResources。
const DIST_DIR = app.isPackaged
  ? join(process.resourcesPath, 'dist')
  : join(fileURLToPath(new URL('..', import.meta.url)), 'dist');
const PRELOAD_PATH = join(dirname(fileURLToPath(import.meta.url)), 'preload.cjs');

// CC_SMOKE=1:无窗冒烟——起内嵌 server、加载页面、探 /api/keys,按结果退码 0/1。
// CC_SMOKE_RENDER=1 追加真渲染探针(打包版验收:预打 bundle + 随包浏览器全链)。
const SMOKE = process.env.CC_SMOKE === '1';
const SMOKE_RENDER = process.env.CC_SMOKE_RENDER === '1';
const SMOKE_TIMEOUT_MS = SMOKE_RENDER ? 240_000 : 90_000;

function registerDesktopHandlers(): void {
  ipcMain.handle('openchatcut:select-directory', async (event, requestedPath: unknown) => {
    const parent = BrowserWindow.fromWebContents(event.sender);
    const requested = typeof requestedPath === 'string' && isAbsolute(requestedPath)
      ? requestedPath
      : app.getPath('videos');
    const options: OpenDialogOptions = {
      title: '选择素材保存目录',
      defaultPath: requested,
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  // KikiVoice auto-connect: IP-based, anonymous (NO login, NO cookie file). A real Chromium
  // BrowserWindow visits kikivoice.ai → Cloudflare issues cf_clearance + KikiVoice issues uuid
  // automatically (cookie-free, proven). The GeeTest 777 gate is solved CRYPTO during synth
  // (GeekedTest via bridge.revalidate / onRevalidateNeeded), NOT here — Connect only acquires uuid.
  ipcMain.handle('openchatcut:kiki-login', async () => {
    const kikiSession = session.fromPartition('persist:kiki');
    // Pin UA to match the transport (cf_clearance binds IP+UA).
    kikiSession.setUserAgent(KIKI_DEFAULT_UA);
    const win = new BrowserWindow({
      width: 1000, height: 820, title: 'KikiVoice — connecting', backgroundColor: '#111111',
      // Bind the window to persist:kiki so the uuid cookie Cloudflare/KikiVoice issue on load lands
      // in the SAME session store the poll above and the server transport (electron-transport.ts)
      // both read. Without this, the window uses session.defaultSession and the uuid never reaches
      // persist:kiki → the poll always times out → {state:'expired'}.
      webPreferences: { partition: 'persist:kiki', contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL('https://kikivoice.ai/');
    // Poll for uuid (auto-issued by page JS on load). No mouse drift / GeeTest click — GeeTest is
    // solved via GeekedTest crypto. Bail early if the user closes the window manually.
    const deadline = Date.now() + 30_000;
    const has = (cookies: { name: string }[], n: string) => cookies.some((c) => c.name === n);
    let userClosed = false;
    win.on('closed', () => { userClosed = true; });
    const safeClose = (): void => { if (!win.isDestroyed()) win.close(); };
    while (Date.now() < deadline && !userClosed) {
      try {
        const cookies = await kikiSession.cookies.get({ domain: 'kikivoice.ai' });
        if (has(cookies, 'uuid')) {
          // uuid acquired — now solve+validate GeeTest so check-status flips true (uuid alone is
          // insufficient; validation is what unlocks the IP for synthesis).
          const validated = await solveAndValidateKikiGeetest();
          safeClose();
          return validated
            ? { state: 'connected' as const, authenticated: true }
            : { state: 'expired' as const, authenticated: false };
        }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    safeClose();
    return { state: 'expired' as const, authenticated: false };
  });
}

async function smokeProbe(origin: string, win: BrowserWindow): Promise<void> {
  const res = await fetch(`${origin}/api/keys`);
  if (!res.ok) throw new Error(`/api/keys → HTTP ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (typeof body !== 'object' || body === null) throw new Error('/api/keys returned non-object');
  const mcp = await fetch(`${origin}/api/external-mcp/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'desktop-smoke', version: '1' } },
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
  if (SMOKE_RENDER) {
    const state = { fps: 30, width: 640, height: 360, items: [], selectedId: null };
    const r = await fetch(`${origin}/render-still`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, frames: [0] }),
    });
    if (!r.ok) throw new Error(`/render-still → HTTP ${r.status}: ${await r.text()}`);
    const rendered = (await r.json()) as { frames?: Array<{ base64?: string }> };
    if (!rendered.frames?.[0]?.base64) throw new Error('/render-still returned no frame');
    console.log(`[smoke] render-still ok, base64 ${rendered.frames[0].base64.length}B`);
    // Remotion can emit late DevTools protocol callbacks after the response.
    // Give its browser cleanup a short drain window before Electron exits.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const KIKI_GEETEST_CAPTCHA_ID = '5046cffe69ee8b5a80766fb9c2769814';

/**
 * Solve the GeeTest 777 per-IP gate cryptographically (GeekedTest) and POST the seccode + public IP
 * to KikiVoice's validation endpoint. This "unlocks" the IP for synthesis — the uuid cookie alone is
 * NOT enough; without this validation check-status stays false and synth is rejected. Proven flow
 * from the spike (.omc/spikes/kiki-autosolve.mjs, 2026-07-26). Reused by the boot auto-acquire
 * (proactive) and the bridge.revalidate hook (reactive, when a 777 fires mid-synth).
 */
async function solveAndValidateKikiGeetest(): Promise<boolean> {
  try {
    const result = await solveGeetest(KIKI_GEETEST_CAPTCHA_ID, 'ai');
    if (!result) return false;
    const ipRes = await fetch('https://api.ipify.org');
    if (!ipRes.ok) return false;
    const ip = (await ipRes.text()).trim();
    if (!ip) return false;
    const payload = {
      captcha_id: KIKI_GEETEST_CAPTCHA_ID,
      lot_number: result.seccode.lot_number,
      pass_token: result.seccode.pass_token,
      gen_time: result.seccode.gen_time,
      captcha_output: result.seccode.captcha_output || result.w,
      user_id: ip,
    };
    const kikiSession = session.fromPartition('persist:kiki');
    const r = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = net.request({ url: 'https://kikivoice.ai/jsapi/auth/geetest-validation', method: 'POST', session: kikiSession, useSessionCookies: true });
      req.setHeader('User-Agent', KIKI_DEFAULT_UA);
      req.setHeader('Origin', 'https://kikivoice.ai');
      req.setHeader('Referer', 'https://kikivoice.ai/ai-voice-cloning');
      req.setHeader('Content-Type', 'application/json');
      const chunks: Buffer[] = [];
      req.on('response', (resp) => { resp.on('data', (c: Buffer) => chunks.push(c)); resp.on('end', () => resolve({ status: resp.statusCode, body: Buffer.concat(chunks).toString('utf8') })); });
      req.on('error', reject);
      req.write(JSON.stringify(payload));
      req.end();
    });
    return r.status === 200 && /success/i.test(r.body);
  } catch {
    return false;
  }
}

// Auto-acquire an anonymous KikiVoice session at boot (no user interaction). A hidden BrowserWindow
// bound to persist:kiki visits kikivoice.ai over the user's IP; Cloudflare issues cf_clearance +
// KikiVoice issues the uuid cookie automatically. GeeTest 777 (per-IP gate) is solved at synth time
// via the bridge's revalidate. Non-blocking — synth waits for checkStatus; if this is still in
// flight or times out, the user can Connect manually from Settings.
async function autoAcquireKikiSession(): Promise<void> {
  const kikiSession = session.fromPartition('persist:kiki');
  // Pin the session UA to KIKI_DEFAULT_UA so cf_clearance (which binds IP+UA) issued by this window
  // matches the UA the ElectronKikiTransport sends later. A UA mismatch invalidates cf_clearance.
  kikiSession.setUserAgent(KIKI_DEFAULT_UA);
  const win = new BrowserWindow({
    width: 1000, height: 820, show: false, backgroundColor: '#111111',
    title: 'KikiVoice — auto-connect',
    webPreferences: { partition: 'persist:kiki', contextIsolation: true, nodeIntegration: false },
  });
  let userClosed = false;
  win.on('closed', () => { userClosed = true; });
  const safeClose = (): void => { if (!win.isDestroyed()) win.close(); };
  try {
    await win.loadURL('https://kikivoice.ai/');
    const deadline = Date.now() + 30_000;
    const has = (cookies: { name: string }[], n: string) => cookies.some((c) => c.name === n);
    let acquired = false;
    while (Date.now() < deadline && !userClosed) {
      try {
        const cookies = await kikiSession.cookies.get({ domain: 'kikivoice.ai' });
        if (has(cookies, 'uuid')) { acquired = true; break; }
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!acquired) { console.warn('[kiki] auto-acquire timed out — Connect manually from Settings if voice fails'); return; }
    // uuid alone is not enough (check-status stays false). Solve the GeeTest 777 gate + POST the
    // validation proactively so the session is synth-ready with zero user action.
    const validated = await solveAndValidateKikiGeetest();
    console.log(validated
      ? '[kiki] anonymous session validated (GeeTest solved) — ready for synth'
      : '[kiki] GeeTest validation failed — retry via Connect or synth-time revalidate');
  } catch (err) {
    console.warn('[kiki] auto-acquire failed:', err instanceof Error ? err.message : err);
  } finally {
    safeClose();
  }
}

async function boot(): Promise<void> {
  await app.whenReady();
  registerDesktopHandlers();
  // Register the KikiVoice session bridge so server plugins can read the persist:partition
  // cookies + bundled ref audio. Lazy getter — safe before the user logs in (returns the session
  // object regardless; auth state is probed per-request via /api/kiki/status).
  setKikiSessionBridge({
    getSession: () => session.fromPartition('persist:kiki'),
    refAudioPath: join(fileURLToPath(new URL('..', import.meta.url)), 'public', 'voices', 'joni.wav'),
    // GeeTest 777 (per-IP) solve + validation — proactive at boot (autoAcquire) and reactive when a
    // 777 fires mid-synth (onRevalidateNeeded). No mouse, no browser, no capsolver.
    revalidate: async () => solveAndValidateKikiGeetest(),
    setCookiesFromNetscape: async (text: string): Promise<number> => {
      // Manual-upload fallback (OpenCut-AI's proven path): inject a Netscape cookie export into
      // the persist:kiki session so the Electron net+session transport carries uuid+cf_clearance+fpestid.
      const kikiSession = session.fromPartition('persist:kiki');
      let count = 0;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const f = line.split('\t');
        if (f.length < 7) continue;
        const [domain, , path, secure, expiry, name, value] = f;
        const host = domain.replace(/^\./, '');
        try {
          await kikiSession.cookies.set({
            url: `https://${host}/`,
            name,
            value: value ?? '',
            domain,
            path: path || '/',
            secure: String(secure).toUpperCase() === 'TRUE',
            httpOnly: false,
            expirationDate: expiry && expiry !== '0' ? Number(expiry) : undefined,
          });
          count++;
        } catch { /* skip malformed row */ }
      }
      return count;
    },
  });
  // Fire-and-forget: acquire the anonymous KikiVoice session in the background so the agent can use
  // kikivoice without the user clicking Connect. Non-blocking; checkStatus gates synth.
  void autoAcquireKikiSession();
  if (app.isPackaged) {
    await preparePackagedRuntime({
      resourcesPath: process.resourcesPath,
      userDataPath: app.getPath('userData'),
      version: app.getVersion(),
    });
  }
  const { origin } = await startEmbeddedServer(DIST_DIR);
  console.log(`[desktop] embedded server at ${origin}`);

  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    show: !SMOKE,
    backgroundColor: '#111111',
    title: 'OpenChatCut',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  await win.loadURL(`${origin}/`);

  // Right-click context menu (browser-style copy/cut/paste/selectAll). Electron shows
  // no context menu by default, so the edit roles must be wired to the renderer.
  win.webContents.on('context-menu', (_event, params) => {
    Menu.buildFromTemplate([
      { role: 'cut', enabled: params.editFlags.canCut },
      { role: 'copy', enabled: params.editFlags.canCopy },
      { role: 'paste', enabled: params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: params.editFlags.canSelectAll },
    ] as MenuItemConstructorOptions[]).popup({ window: win });
  });

  if (SMOKE) {
    await smokeProbe(origin, win);
    console.log('SMOKE-OK');
    app.exit(0);
  }
}

app.on('window-all-closed', () => app.quit());

if (SMOKE) {
  setTimeout(() => {
    console.error('smoke timed out');
    app.exit(2);
  }, SMOKE_TIMEOUT_MS).unref();
}

boot().catch((err) => {
  console.error('[desktop] boot failed:', err instanceof Error ? err.stack ?? err.message : err);
  app.exit(1);
});
