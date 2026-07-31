import assert from 'node:assert/strict';
import {
  safePublicFetch,
  UnsafePublicUrlError,
  type PublicUrlResolver,
  type PublicUrlTransport,
} from './safe-public-fetch';

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

console.log('safe public fetch verification passed');
