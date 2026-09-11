// Electron main-process entry. It exists only so that a failure while loading
// the application bundle stays visible.
//
// esbuild hoists every external import to the top of the bundle it emits, so a
// single unresolvable dependency — a damaged app.asar, a module quarantined out
// of app.asar.unpacked — aborts module evaluation before any of our code runs.
// The process then exits into a console a double-click never has: no window, no
// dialog, nothing to report. That is issue #140's first failure
// (`Cannot find package 'jieba-wasm'`), and neither boot()'s catch nor the
// packaged asset preflight can reach it, because both live inside the bundle
// that failed to load. Keeping the application in a second bundle that this one
// imports dynamically turns that abort into a catchable rejection.
//
// Anything that must run before Electron initializes V8 or emits 'ready' also
// belongs here: the dynamic import below settles asynchronously, so module-scope
// work inside the application bundle no longer happens before the first tick.
import { app, dialog } from 'electron';
import { RUNTIME_ASSET_ADVICE } from './runtime-preflight.ts';

// Remotion renders export frames inside this process (main + headless tabs).
// Raise the V8 heap ceiling so large/4K exports don't die with "out of memory"
// (issue #40). Must run before app 'ready'; js-flags apply to every V8 instance.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=6144');

try {
  // Relative and marked external on purpose: desktop:build:main emits
  // app-main.mjs as its own bundle beside this file, so that bundle's imports
  // resolve here, inside this try.
  await import('./app-main.mjs');
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error('[desktop] failed to load the application bundle:', detail);
  if (process.env.CC_SMOKE !== '1') {
    try {
      dialog.showErrorBox('OpenChatCut 启动失败 / failed to start', [
        '无法加载程序主体 / could not load the application bundle:',
        '',
        error instanceof Error ? error.message : String(error),
        '',
        RUNTIME_ASSET_ADVICE,
      ].join('\n'));
    } catch {
      // A dialog is best effort; the exit below still has to happen.
    }
  }
  app.exit(1);
}
