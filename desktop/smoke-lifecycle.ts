import { spawn } from 'node:child_process';

/**
 * On Windows, after forced renderer crashes, BOTH in-process exits have been
 * observed to wedge: app.exit() (v0.2.12 CI run 3) and even process.exit
 * following it (same run — the process survived to the external 420s kill).
 * So: arm an EXTERNAL kill on failure codes first, then process.exit
 * directly — app.exit posts through Chromium's message loop, which is
 * exactly the thing that deadlocks, and a smoke process has nothing worth a
 * graceful quit. The CI step treats a printed SMOKE-OK as the pass signal,
 * so a post-success wedge cannot fail the build.
 */
export function exitSmoke(code: number): void {
  // Failure only: taskkill terminates with its own nonzero status, which
  // must never be able to turn a SMOKE-OK exit 0 into a failure.
  if (code !== 0 && process.platform === 'win32') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(process.pid)], {
        detached: true,
        stdio: 'ignore',
      }).unref();
    } catch {
      // process.exit below remains the only path.
    }
  }
  process.exit(code);
}

// A detached helper remains live even if the main-process event loop wedges.
function armWindowsSmokeWatchdog(timeoutMs: number): void {
  try {
    const graceSeconds = Math.ceil(timeoutMs / 1000) + 60;
    const helper = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Start-Sleep -Seconds ${graceSeconds}; taskkill /T /F /PID ${process.pid}`,
    ], { detached: true, stdio: 'ignore' });
    helper.unref();
    // The pid line is diagnostic: run 6's helper never fired and this says
    // whether it even spawned.
    console.log(`[smoke] external watchdog armed: helper pid ${helper.pid ?? 'SPAWN FAILED'}, fires in ${graceSeconds}s`);
  } catch (error) {
    console.error('[smoke] external watchdog spawn failed:', error instanceof Error ? error.message : String(error));
  }
}

export function installSmokeWatchdog(timeoutMs: number): void {
  // No .unref(): in the Electron main process an unref'd timer is not
  // guaranteed to ever fire — Node's loop is polled through Chromium's message
  // pump, and with no ref'd handles the poll can starve. The v0.2.12 Windows
  // smoke hung for 105 minutes on a 240s watchdog that never fired. A ref'd
  // timer does not block app.exit(0) on the success path, so there is nothing
  // to unref for.
  setTimeout(() => {
    console.error(`smoke timed out after ${timeoutMs}ms`);
    exitSmoke(2);
  }, timeoutMs);
  // Pre-armed EXTERNAL watchdog: the Windows main process has wedged so hard
  // during smoke (crashed-renderer teardown) that timers, microtasks, and
  // both in-process exits all stopped — the setTimeout above never even
  // logged. A detached helper is immune to that. On a clean exit our PID is
  // gone before the helper fires and the kill is a no-op; CI reaps the
  // helper as an orphan.
  if (process.platform === 'win32') armWindowsSmokeWatchdog(timeoutMs);
}
