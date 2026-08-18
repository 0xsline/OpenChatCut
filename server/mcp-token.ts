import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 32 random bytes as base64url, the shape externalMcpToken always minted. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface McpTokenLocation {
  /** Overridable for tests; never for callers wiring the real server. */
  readonly home?: string;
  /** Isolated dev profiles keep their own token so checkouts stay independent. */
  readonly profileId?: string;
}

/**
 * Where the persistent MCP token lives. Deliberately under the HOME-anchored
 * hidden root and NOT under the user-chosen data dir: the data dir may sit in a
 * synced folder (that is the point of making it configurable), and a bearer
 * secret must not ride a sync service onto other machines. Same reasoning as
 * the data-dir pointer file itself.
 */
export function mcpTokenPath({ home = homedir(), profileId }: McpTokenLocation = {}): string {
  const root = profileId
    ? join(home, '.openchatcut', 'dev-profiles', profileId)
    : join(home, '.openchatcut');
  return join(root, 'mcp-token');
}

export interface McpTokenResult {
  readonly token: string;
  /** False when the filesystem refused: the token is valid but per-process. */
  readonly persisted: boolean;
}

/**
 * The token external agents authenticate with, minted once and reused.
 *
 * It used to be random per process, which quietly broke every registered agent
 * on each app restart: the copied `claude mcp add` command carried a token that
 * no longer existed, and for a Claude Code subscriber that command is the only
 * way into the app. Persisting the first token makes registration a one-time
 * step. OPENCHATCUT_MCP_TOKEN still overrides (handled by the caller), and a
 * filesystem failure falls back to the old per-process behaviour rather than
 * refusing to serve.
 */
export function loadOrCreateMcpToken(location: McpTokenLocation = {}): McpTokenResult {
  const path = mcpTokenPath(location);
  const readValid = (): string | null => {
    try {
      const existing = readFileSync(path, 'utf8').trim();
      return TOKEN_PATTERN.test(existing) ? existing : null;
    } catch {
      return null;
    }
  };
  const existing = readValid();
  if (existing !== null) return { token: existing, persisted: true };
  // A malformed file is replaced rather than trusted: serving whatever ended up
  // in it would turn a corrupted write into the endpoint's credential. Removing
  // it (instead of overwriting) also sheds whatever loose permissions the old
  // file carried, so the healed credential is always written fresh at 0600.
  try {
    unlinkSync(path);
  } catch {
    // Missing file: first launch.
  }
  const token = randomBytes(32).toString('base64url');
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Exclusive create: the profile-scoped instance lock does not serialize a
    // packaged app against a dev server sharing the same HOME, so two first
    // launches can race to mint. 'wx' lets exactly one write win; the loser
    // adopts the winner below, and both processes end up serving the token the
    // file actually holds.
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: 'wx' });
    return { token, persisted: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const winner = readValid();
      if (winner !== null) return { token: winner, persisted: true };
    }
    return { token, persisted: false };
  }
}
