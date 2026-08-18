import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The documented external-MCP address; README and the MCP panel assume it. */
export const CANONICAL_EMBEDDED_PORT = 5199;

export interface EmbeddedPortLocation {
  /** Overridable for tests; never for callers wiring the real server. */
  readonly home?: string;
  /** Isolated dev profiles keep their own memory, exactly like the MCP token:
   *  the profile-scoped instance lock lets a packaged app and a dev checkout
   *  run concurrently, and one memory slot shared between them would ping-pong
   *  at every contended launch — the very instability this file removes. */
  readonly profileId?: string;
}

/** Same HOME-anchored hidden root as the MCP token, and for the same reason:
 *  the user-chosen data dir may be a synced folder, and machine-local wiring
 *  state has no business following a sync service to another machine. */
export function embeddedPortPath({ home = homedir(), profileId }: EmbeddedPortLocation = {}): string {
  const root = profileId
    ? join(home, '.openchatcut', 'dev-profiles', profileId)
    : join(home, '.openchatcut');
  return join(root, 'mcp-port');
}

export function readRememberedPort(location: EmbeddedPortLocation = {}): number | null {
  try {
    const port = Number(readFileSync(embeddedPortPath(location), 'utf8').trim());
    // The canonical port is never remembered: it is always tried first anyway,
    // and remembering it would just shadow a stale write.
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === CANONICAL_EMBEDDED_PORT) {
      return null;
    }
    return port;
  } catch {
    return null;
  }
}

export function rememberPort(port: number, location: EmbeddedPortLocation = {}): boolean {
  try {
    const path = embeddedPortPath(location);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${port}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export interface ListenWithAffinityOptions extends EmbeddedPortLocation {
  /** Overridable for tests; the real server always uses the documented port. */
  readonly canonicalPort?: number;
  readonly log?: (message: string) => void;
}

/**
 * Bind the embedded server to a port external agents can rely on.
 *
 * The canonical port comes first so the documented address self-heals the
 * moment whatever occupied it goes away. When it is taken, the port used the
 * LAST time this happened is tried before anything random: the usual occupant
 * is a long-lived neighbour (a dev server, another tool), so the conflict
 * repeats at every launch, and a random port each time silently broke every
 * registered MCP client. Only when both are busy does a fresh random port get
 * picked, and it immediately becomes the remembered one.
 */
export async function listenWithAffinity(
  server: Server,
  { canonicalPort = CANONICAL_EMBEDDED_PORT, home, profileId, log = console.warn }: ListenWithAffinityOptions = {},
): Promise<number> {
  const listenOn = (port: number) => new Promise<number>((resolvePort, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      const addr = server.address();
      if (addr && typeof addr === 'object') resolvePort(addr.port);
      else reject(new Error('embedded server failed to bind'));
    });
  });
  const inUse = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'EADDRINUSE';

  try {
    return await listenOn(canonicalPort);
  } catch (err) {
    if (!inUse(err)) throw err;
  }
  const remembered = readRememberedPort({ home, profileId });
  if (remembered !== null) {
    try {
      const port = await listenOn(remembered);
      log(`[embedded-server] port ${canonicalPort} in use — reusing remembered fallback ${port}`);
      return port;
    } catch (err) {
      if (!inUse(err)) throw err;
    }
  }
  const port = await listenOn(0);
  rememberPort(port, { home, profileId });
  log(`[embedded-server] port ${canonicalPort} in use — falling back to ${port}, kept for future launches; point external MCP clients at the origin logged below`);
  return port;
}
