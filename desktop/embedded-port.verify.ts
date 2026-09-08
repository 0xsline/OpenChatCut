import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedPortPath, listenWithAffinity, readRememberedPort, rememberPort } from './embedded-port.ts';

const home = mkdtempSync(join(tmpdir(), 'occ-port-'));
const servers: Server[] = [];
const fresh = (): Server => {
  const server = createServer((_req, res) => res.end('ok'));
  servers.push(server);
  return server;
};
const bindRandom = (server: Server) => new Promise<number>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address();
    if (addr && typeof addr === 'object') resolve(addr.port);
    else reject(new Error('bind failed'));
  });
});
const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));
const silent = () => {};

try {
  // Reserve two real ports to stand in for "canonical" and its occupant, so the
  // suite never touches the machine's actual 5199 (often busy on a dev box).
  const canonicalBlocker = fresh();
  const canonical = await bindRandom(canonicalBlocker);
  await close(canonicalBlocker);
  servers.pop();

  // Canonical free: bound directly and remembered as the stable endpoint.
  const direct = fresh();
  assert.equal(await listenWithAffinity(direct, { canonicalPort: canonical, home, log: silent }), canonical);
  assert.equal(readRememberedPort({ home }), canonical, 'the canonical endpoint is remembered too');
  await close(direct);

  // Canonical busy, nothing remembered: a random port is picked AND persisted,
  // owner-only, so the next conflicted launch lands on the same address.
  const occupant = fresh();
  await new Promise<void>((resolve, reject) => {
    occupant.once('error', reject);
    occupant.listen(canonical, '127.0.0.1', () => resolve());
  });
  const first = fresh();
  const fallback = await listenWithAffinity(first, { canonicalPort: canonical, home, log: silent });
  assert.notEqual(fallback, canonical);
  assert.equal(readRememberedPort({ home }), fallback, 'the fallback is remembered');
  // POSIX permission bits: Windows reports no owner-only mode.
  if (process.platform !== 'win32') {
    assert.equal(statSync(embeddedPortPath({ home })).mode & 0o777, 0o600, 'port file is owner-only');
  }
  await close(first);

  // Same conflict on the next launch: the SAME fallback comes back. This is the
  // whole point — a registered MCP client keeps its address across restarts.
  const second = fresh();
  assert.equal(
    await listenWithAffinity(second, { canonicalPort: canonical, home, log: silent }),
    fallback,
    'a repeated conflict reuses the remembered fallback',
  );
  await close(second);

  // Canonical AND remembered both busy: a new random port, which replaces the
  // remembered one instead of leaving a stale pointer behind.
  const fallbackBlocker = fresh();
  await new Promise<void>((resolve, reject) => {
    fallbackBlocker.once('error', reject);
    fallbackBlocker.listen(fallback, '127.0.0.1', () => resolve());
  });
  const third = fresh();
  const rerolled = await listenWithAffinity(third, { canonicalPort: canonical, home, log: silent });
  assert.ok(rerolled !== canonical && rerolled !== fallback);
  assert.equal(readRememberedPort({ home }), rerolled, 'the new fallback replaces the old one');
  await close(third);
  await close(fallbackBlocker);

  // The conflict goes away: the registered fallback remains stable instead of
  // silently moving external clients back to the canonical address.
  await close(occupant);
  const stable = fresh();
  assert.equal(
    await listenWithAffinity(stable, { canonicalPort: canonical, home, log: silent }),
    rerolled,
    'the last registered endpoint wins while it remains available',
  );
  await close(stable);

  // A corrupted or nonsensical port file is ignored rather than dialled.
  writeFileSync(embeddedPortPath({ home }), 'pas-un-port\n');
  assert.equal(readRememberedPort({ home }), null);
  writeFileSync(embeddedPortPath({ home }), '80\n');
  assert.equal(readRememberedPort({ home }), null, 'privileged ports are never remembered');
  assert.ok(rememberPort(rerolled, { home }), 'a valid port can be written back');
  assert.equal(readFileSync(embeddedPortPath({ home }), 'utf8').trim(), String(rerolled));

  // A dev profile keeps its own memory: the profile-scoped instance lock lets a
  // packaged app and a dev checkout run at once, and a shared slot would
  // ping-pong between them at every contended launch.
  const profileId = '9b6a2f00-1234-4abc-8def-556677889900';
  assert.ok(rememberPort(6001, { home, profileId }));
  assert.equal(readRememberedPort({ home, profileId }), 6001);
  assert.equal(readRememberedPort({ home }), rerolled, 'the default profile memory is untouched');
  assert.ok(embeddedPortPath({ home, profileId }).includes('dev-profiles'), 'profile memory lives under its profile root');

  console.log('embedded-port.verify OK');
} finally {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  rmSync(home, { recursive: true, force: true });
}
