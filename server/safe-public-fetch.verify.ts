import assert from 'node:assert/strict';
import { Agent as HttpAgent } from 'node:http';
import { type AddressInfo, connect, createServer, Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import {
  PublicConnectTimeoutError,
  PublicResponseTimeoutError,
  safePublicFetch,
  UnsafePublicUrlError,
  type PublicUrlResolver,
  type PublicUrlTransport,
} from './safe-public-fetch';
import { outboundProxyUrl } from './outbound-proxy.ts';

const PUBLIC_IPV4 = '93.184.216.34';
const publicResolver: PublicUrlResolver = async () => [{ address: PUBLIC_IPV4, family: 4 }];

async function assertRejectedBeforeTransport(url: string, resolver: PublicUrlResolver = publicResolver): Promise<void> {
  let transportCalls = 0;
  await assert.rejects(
    () => safePublicFetch(url, {
      resolver,
      transport: async () => {
        transportCalls += 1;
        return new Response(null, { status: 200 });
      },
    }),
    (error: unknown) => error instanceof UnsafePublicUrlError,
  );
  assert.equal(transportCalls, 0, `${url} must be rejected before transport`);
}

for (const address of [
  '127.0.0.1',
  '10.0.0.1',
  '172.16.0.1',
  '192.168.0.1',
  '169.254.169.254',
  '0.0.0.0',
  '224.0.0.1',
]) {
  await assertRejectedBeforeTransport(`http://${address}/media.mp4`);
}
await assertRejectedBeforeTransport('http://[::1]/media.mp4');
await assertRejectedBeforeTransport('http://[::ffff:127.0.0.1]/media.mp4');
await assertRejectedBeforeTransport('http://localhost/media.mp4');
await assertRejectedBeforeTransport('http://metadata.google.internal/latest/meta-data');
await assertRejectedBeforeTransport('https://user:secret@media.example/media.mp4');
await assertRejectedBeforeTransport('https://media.example:8443/media.mp4');
await assertRejectedBeforeTransport(
  'https://private-dns.example/media.mp4',
  async () => [{ address: '192.168.1.10', family: 4 }],
);
await assertRejectedBeforeTransport(
  'https://mixed-dns.example/media.mp4',
  async () => [
    { address: PUBLIC_IPV4, family: 4 },
    { address: '10.0.0.2', family: 4 },
  ],
);

let redirectTransportCalls = 0;
await assert.rejects(
  () => safePublicFetch('https://public.example/media.mp4', {
    resolver: publicResolver,
    transport: async () => {
      redirectTransportCalls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      });
    },
  }),
  (error: unknown) => error instanceof UnsafePublicUrlError,
);
assert.equal(redirectTransportCalls, 1, 'a private redirect target must be rejected before a second transport');

let resolverCalls = 0;
let pinnedAddress = '';
let observedHost = '';
let observedServerName = '';
let observedRange = '';
const rebindingResolver: PublicUrlResolver = async () => {
  resolverCalls += 1;
  return resolverCalls === 1
    ? [{ address: PUBLIC_IPV4, family: 4 }]
    : [{ address: '127.0.0.1', family: 4 }];
};
const pinnedTransport: PublicUrlTransport = async (request) => {
  pinnedAddress = request.address;
  observedHost = request.hostHeader;
  observedServerName = request.serverName ?? '';
  observedRange = request.headers.get('Range') ?? '';
  return new Response(null, {
    status: 206,
    headers: { 'content-type': 'video/mp4' },
  });
};
const publicResponse = await safePublicFetch('https://media.example/video.mp4', {
  headers: { Range: 'bytes=0-0' },
  resolver: rebindingResolver,
  transport: pinnedTransport,
});
assert.equal(publicResponse.status, 206);
assert.equal(resolverCalls, 1, 'the transport must not resolve the hostname again');
assert.equal(pinnedAddress, PUBLIC_IPV4);
assert.equal(observedHost, 'media.example');
assert.equal(observedServerName, 'media.example');
assert.equal(observedRange, 'bytes=0-0');

// The connect phase is bounded on its own. An agent that hands back a socket which never
// connects and never errors is exactly a blackholed host; without the bound this request
// would sit in the OS TCP connect timeout (~75s on macOS) and, in a batch, serially.
{
  class StallAgent extends HttpAgent {
    override createConnection(): Socket {
      // A handshake that never completes. While `connecting`, net.Socket queues writes
      // instead of failing them, so the request head sits in the buffer forever — the
      // exact shape of a SYN into a blackhole. (A bare Socket would fail the write with
      // ERR_SOCKET_CLOSED and prove nothing about the bound.)
      const socket = new Socket();
      (socket as { connecting: boolean }).connecting = true;
      return socket;
    }
  }
  const started = performance.now();
  await assert.rejects(
    () => safePublicFetch('http://93.184.216.34/media.mp4', { agent: new StallAgent(), connectTimeoutMs: 200 }),
    (error: unknown) => error instanceof PublicConnectTimeoutError
      && error.timeoutMs === 200 && error.address === '93.184.216.34' && error.host === '93.184.216.34',
  );
  assert.ok(performance.now() - started < 3000, 'the connect bound must fire, not the OS default');
}

// The default transport honors the user's outbound proxy like every other server path. With
// HTTPS_PROXY pointing at a closed loopback port, the failure must be the proxy refusing —
// proof the request went to the proxy rather than dialing the target directly.
{
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.HTTPS_PROXY = 'http://127.0.0.1:1';
  try {
    assert.equal(outboundProxyUrl(), 'http://127.0.0.1:1', 'the env proxy must be what resolves in this process');
    await assert.rejects(
      () => safePublicFetch('https://93.184.216.34/media.mp4', { connectTimeoutMs: 5_000 }),
      (error: unknown) => (error as { code?: string }).code === 'ECONNREFUSED'
        && String((error as Error).message).includes('127.0.0.1:1'),
    );
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

// A proxy CONNECT that never completes leaves the request with no socket at all. Node holds
// the request's 'error' back until the agent produces one, so destroying the request cannot
// enforce the bound on its own; the transport has to settle the promise itself.
{
  class NeverConnectAgent extends HttpAgent {
    override createConnection(): Socket {
      // Neither hands back a socket nor calls back: the agent's connect is pending forever.
      return undefined as unknown as Socket;
    }
  }
  const started = performance.now();
  await assert.rejects(
    () => safePublicFetch('http://93.184.216.34/media.mp4', { agent: new NeverConnectAgent(), connectTimeoutMs: 200 }),
    (error: unknown) => error instanceof PublicConnectTimeoutError && error.timeoutMs === 200,
  );
  assert.ok(performance.now() - started < 3000, 'a pending agent connect must not defer the bound');
}

// A server that accepts and never says anything stands in for two real shapes: a proxy that
// answers CONNECT before it has reached the upstream, and a host that takes the request and
// stalls. The plain socket connects at once, so the connect bound is satisfied; https must
// still wait for the TLS handshake, and the header bound covers whatever remains.
{
  const silent = createServer(() => { /* accept, never respond */ });
  const held = new Set<Socket>();
  silent.on('connection', (socket) => { held.add(socket); });
  await new Promise<void>((resolveListen) => silent.listen(0, '127.0.0.1', resolveListen));
  const port = (silent.address() as AddressInfo).port;
  class SilentAgent extends HttpAgent {
    override createConnection(): Socket { return connect(port, '127.0.0.1'); }
  }
  class StalledTlsAgent extends HttpAgent {
    override createConnection(): Socket {
      return tlsConnect({ socket: connect(port, '127.0.0.1'), rejectUnauthorized: false });
    }
  }
  try {
    let started = performance.now();
    await assert.rejects(
      () => safePublicFetch('http://93.184.216.34/media.mp4', {
        agent: new SilentAgent(), connectTimeoutMs: 5_000, headersTimeoutMs: 300,
      }),
      (error: unknown) => error instanceof PublicResponseTimeoutError
        && error.timeoutMs === 300 && error.address === '93.184.216.34',
    );
    assert.ok(performance.now() - started < 3000, 'a connected socket that never answers hits the header bound');

    started = performance.now();
    await assert.rejects(
      () => safePublicFetch('http://93.184.216.34/media.mp4', {
        agent: new StalledTlsAgent(), connectTimeoutMs: 200, headersTimeoutMs: 5_000,
      }),
      (error: unknown) => error instanceof PublicConnectTimeoutError && error.timeoutMs === 200,
    );
    assert.ok(performance.now() - started < 3000, 'a stalled TLS handshake is a connect failure, not a connected socket');
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise<void>((resolveClose) => silent.close(() => resolveClose()));
  }
}

console.log('safe public fetch verification passed');
