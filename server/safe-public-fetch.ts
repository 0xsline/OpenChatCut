import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

export interface PublicAddress {
  address: string;
  family: 4 | 6;
}

export type PublicUrlResolver = (hostname: string) => Promise<readonly PublicAddress[]>;

export interface PinnedPublicRequest {
  url: URL;
  address: string;
  family: 4 | 6;
  hostHeader: string;
  serverName?: string;
  method: 'GET' | 'HEAD';
  headers: Headers;
  signal?: AbortSignal;
}

export type PublicUrlTransport = (request: PinnedPublicRequest) => Promise<Response>;

export interface SafePublicFetchInit {
  method?: 'GET' | 'HEAD';
  headers?: HeadersInit;
  signal?: AbortSignal;
  cache?: RequestCache;
  resolver?: PublicUrlResolver;
  transport?: PublicUrlTransport;
  maxRedirects?: number;
}

export class UnsafePublicUrlError extends Error {
  readonly code = 'unsafe_public_url';

  constructor(message: string) {
    super(message);
    this.name = 'UnsafePublicUrlError';
  }
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value | PromiseLike<Value>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolve: Deferred<Value>['resolve'] | undefined;
  let reject: Deferred<Value>['reject'] | undefined;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  if (!resolve || !reject) throw new Error('Promise executor did not initialize synchronously');
  return { promise, resolve, reject };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const METADATA_HOSTS: Record<string, true> = {
  'metadata.google.internal': true,
  'metadata.google': true,
  'instance-data': true,
  'metadata.azure.internal': true,
};

function parseIpv4(address: string): readonly [number, number, number, number] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN);
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
  return octets as unknown as readonly [number, number, number, number];
}

function isPublicIpv4(address: string): boolean {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function parseIpv6(address: string): Uint8Array | null {
  let value = address.toLowerCase();
  if (value.includes('%')) return null;
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const ipv4 = separator >= 0 ? parseIpv4(value.slice(separator + 1)) : null;
    if (!ipv4) return null;
    const high = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const low = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    value = `${value.slice(0, separator)}:${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const explicit = left.length + right.length;
  const zeroGroups = halves.length === 2 ? 8 - explicit : 0;
  if (explicit > 8 || halves.length === 1 && explicit !== 8 || halves.length === 2 && zeroGroups < 1) return null;
  const groups = [...left, ...Array.from({ length: zeroGroups }, () => '0'), ...right];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const number = Number.parseInt(group, 16);
    bytes[index * 2] = number >>> 8;
    bytes[index * 2 + 1] = number & 0xff;
  });
  return bytes;
}

function isPublicIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (!bytes) return false;
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0)
    && bytes[10] === 0xff
    && bytes[11] === 0xff;
  if (mapped) return isPublicIpv4(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  if (bytes.slice(0, 12).every((byte) => byte === 0)) return false;
  if (bytes[0] === 0xff) return false;
  if ((bytes[0] & 0xfe) === 0xfc) return false;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return false;
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPublicIpv4(`${bytes[2]}.${bytes[3]}.${bytes[4]}.${bytes[5]}`);
  }
  return (bytes[0] & 0xe0) === 0x20;
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? isPublicIpv4(address) : family === 6 && isPublicIpv6(address);
}

function normalizedHostname(url: URL): string {
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return hostname.toLowerCase().replace(/\.$/, '');
}

function validateUrlShape(url: URL): string {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafePublicUrlError('url must use http or https');
  }
  if (url.username || url.password) throw new UnsafePublicUrlError('credential URLs are not allowed');
  const expectedPort = url.protocol === 'http:' ? '80' : '443';
  if (url.port && url.port !== expectedPort) throw new UnsafePublicUrlError('non-standard URL ports are not allowed');
  const hostname = normalizedHostname(url);
  if (!hostname) throw new UnsafePublicUrlError('url hostname is missing');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')
    || hostname.endsWith('.internal') || METADATA_HOSTS[hostname]) {
    throw new UnsafePublicUrlError('url hostname is not public');
  }
  return hostname;
}

const defaultResolver: PublicUrlResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  const { promise, resolve, reject } = createDeferred<T>();
  const cleanup = () => signal.removeEventListener('abort', onAbort);
  const onAbort = () => {
    cleanup();
    reject(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  operation.then(
    (value) => {
      cleanup();
      resolve(value);
    },
    (error: unknown) => {
      cleanup();
      reject(error);
    },
  );
  return promise;
}

async function resolvePublicTarget(
  url: URL,
  resolver: PublicUrlResolver,
  signal: AbortSignal | undefined,
): Promise<PublicAddress> {
  const hostname = validateUrlShape(url);
  const literalFamily = isIP(hostname);
  const addresses: readonly PublicAddress[] = literalFamily
    ? [{ address: hostname, family: literalFamily === 6 ? 6 : 4 }]
    : await abortable(resolver(hostname), signal);
  if (addresses.length === 0) throw new UnsafePublicUrlError('url hostname did not resolve');
  for (const candidate of addresses) {
    const actualFamily = isIP(candidate.address);
    if ((actualFamily !== 4 && actualFamily !== 6) || !isPublicAddress(candidate.address)) {
      throw new UnsafePublicUrlError('url hostname resolved to a non-public address');
    }
  }
  const selected = addresses[0]!;
  return { address: selected.address, family: isIP(selected.address) === 6 ? 6 : 4 };
}

const defaultTransport: PublicUrlTransport = (request) => {
  const { promise, resolve, reject } = createDeferred<Response>();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => { headers[name] = value; });
  headers.host = request.hostHeader;
  const send = request.url.protocol === 'https:' ? httpsRequest : httpRequest;
  const outgoing = send({
    protocol: request.url.protocol,
    hostname: request.address,
    family: request.family,
    port: request.url.protocol === 'https:' ? 443 : 80,
    method: request.method,
    path: `${request.url.pathname}${request.url.search}`,
    headers,
    signal: request.signal,
    ...(request.serverName ? { servername: request.serverName } : {}),
  }, (incoming) => {
    const status = incoming.statusCode ?? 502;
    if (status < 200 || status > 599) {
      incoming.destroy();
      reject(new Error(`unsupported upstream HTTP status ${status}`));
      return;
    }
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) {
      if (Array.isArray(value)) value.forEach((entry) => responseHeaders.append(name, entry));
      else if (value !== undefined) responseHeaders.set(name, value);
    }
    const bodyAllowed = request.method !== 'HEAD' && status !== 204 && status !== 205 && status !== 304;
    const body = bodyAllowed ? Readable.toWeb(incoming) as unknown as BodyInit : null;
    try {
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders,
      }));
    } catch (error) {
      incoming.destroy();
      reject(error);
    }
  });
  outgoing.on('error', reject);
  outgoing.end();
  return promise;
};

function requestFor(url: URL, target: PublicAddress, init: SafePublicFetchInit): PinnedPublicRequest {
  const hostname = normalizedHostname(url);
  return {
    url,
    address: target.address,
    family: target.family,
    hostHeader: url.host,
    serverName: isIP(hostname) === 0 ? hostname : undefined,
    method: init.method ?? 'GET',
    headers: new Headers(init.headers),
    signal: init.signal,
  };
}

/** Fetch a public URL without allowing redirects or DNS rebinding to escape the validated address. */
export async function safePublicFetch(input: string | URL, init: SafePublicFetchInit = {}): Promise<Response> {
  const resolver = init.resolver ?? defaultResolver;
  const transport = init.transport ?? defaultTransport;
  const maxRedirects = Math.min(5, Math.max(0, Math.trunc(init.maxRedirects ?? 5)));
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.href) : new URL(input);
  } catch {
    throw new UnsafePublicUrlError('url is invalid');
  }

  for (let redirects = 0; ; redirects += 1) {
    const target = await resolvePublicTarget(url, resolver, init.signal);
    const response = await abortable(transport(requestFor(url, target, init)), init.signal);
    const location = response.headers.get('location');
    if (!REDIRECT_STATUSES.has(response.status) || !location) return response;
    await response.body?.cancel().catch(() => undefined);
    if (redirects >= maxRedirects) throw new UnsafePublicUrlError('too many redirects');
    try {
      url = new URL(location, url);
    } catch {
      throw new UnsafePublicUrlError('redirect location is invalid');
    }
  }
}
