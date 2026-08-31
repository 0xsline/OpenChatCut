import { BrowserWindow } from 'electron';

const RECOVERY_TIMEOUT_MS = 10_000;
// A fresh BrowserWindow cold-boots a whole renderer (parse, locale dict, lazy
// chunks) before the transcript view mounts; 10s is too tight on a throttled
// CI machine even with the pull path in place.
const TRANSCRIPT_TIMEOUT_MS = 30_000;

async function crashAndWait(win: BrowserWindow): Promise<void> {
  const recovered = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('renderer crash recovery timed out')), RECOVERY_TIMEOUT_MS);
    win.webContents.once('did-finish-load', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  win.webContents.forcefullyCrashRenderer();
  await recovered;
  const title = await win.webContents.executeJavaScript('document.title') as unknown;
  if (title !== 'OpenChatCut') throw new Error(`renderer recovered with unexpected title: ${String(title)}`);
}

async function waitForTranscript(win: BrowserWindow, name: string): Promise<void> {
  await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('transcript payload timed out')); }, ${TRANSCRIPT_TIMEOUT_MS});
    function check() {
      if (!document.body?.textContent?.includes(${JSON.stringify(name)})) return;
      observer.disconnect(); clearTimeout(timer); resolve(true);
    }
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    check();
  })`);
}

export async function runDesktopRendererRecoverySmoke(win: BrowserWindow): Promise<void> {
  await crashAndWait(win);
  console.log('[smoke] renderer crash recovered');
  const payload = {
    entries: [{ id: 'recovery-smoke', name: 'Transcript recovery initial', transcript: [{ text: 'recovered speech', start: 0, end: 1000 }] }],
    index: 0,
  };
  await win.webContents.executeJavaScript(`window.openChatCutDesktop.openTranscriptWindow(${JSON.stringify(payload)})`);
  const floating = BrowserWindow.getAllWindows().find((candidate) => candidate !== win);
  if (!floating) throw new Error('floating transcript window was not created');
  await waitForTranscript(floating, payload.entries[0]!.name);
  const latest = { ...payload, entries: [{ ...payload.entries[0]!, name: 'Transcript recovery latest' }] };
  await win.webContents.executeJavaScript(`window.openChatCutDesktop.openTranscriptWindow(${JSON.stringify(latest)})`);
  await waitForTranscript(floating, latest.entries[0]!.name);
  await crashAndWait(floating);
  await waitForTranscript(floating, latest.entries[0]!.name);
  console.log('[smoke] floating transcript crash restored the latest payload');
  // No close() and no destroy(): tearing down a window whose renderer went
  // through forcefullyCrashRenderer + reload deadlocks the Windows main
  // process either way (v0.2.12 CI runs 5 and 6 — the success line above
  // printed, then timers, microtasks and every exit path stopped). This is
  // the smoke's final phase; the process exits right after and the OS reaps
  // the window.
}
