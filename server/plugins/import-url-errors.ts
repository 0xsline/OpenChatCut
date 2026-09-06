// Turn a low-level network failure from a remote media import into something the agent
// and the user can act on.
//
// The raw failure was `connect ETIMEDOUT 159.106.121.75:443`: an IP with no hostname, no
// hint that the address is simply unreachable from this network, and no pointer to the
// proxy setting that fixes it. download_media then registered the URL as a "remote src"
// and reported success, so a blocked host produced a dead asset and a misleading "done".
// Unreachable is a distinct outcome — it names the host, says what to change, and carries
// a code the tool can turn into a real failure instead of a downgrade.
import { PublicConnectTimeoutError, PublicResponseTimeoutError } from '../safe-public-fetch.ts';
import { outboundProxyUrl } from '../outbound-proxy.ts';

const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
]);

export class ImportUnreachableError extends Error {
  readonly code = 'upstream_unreachable';

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ImportUnreachableError';
  }
}

const hostOf = (remote: string): string => {
  try {
    return new URL(remote).host;
  } catch {
    return remote;
  }
};

const errorCode = (error: unknown): string | null => {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

const DIRECT_REMEDY = '该地址可能被当前网络屏蔽或需要代理。请检查网络，或在 设置 → Agent 模型 中配置 PROXY_URL；也可以换一个能直连的素材地址。';
const PROXIED_REMEDY = '当前已经通过代理访问，代理也连不上这个主机。请检查代理规则，或换一个能访问的素材地址。';

/** Which of the two things the user can change is the one that matters right now. */
const remedy = (): string => (outboundProxyUrl() ? PROXIED_REMEDY : DIRECT_REMEDY);

/** Null when the failure is not a connectivity problem, so callers keep their own handling. */
export function unreachableImportError(error: unknown, remote: string): ImportUnreachableError | null {
  const host = hostOf(remote);
  if (error instanceof PublicConnectTimeoutError) {
    return new ImportUnreachableError(
      `连接 ${host} 超时（${error.timeoutMs}ms 内未建立连接，${error.address}）。${remedy()}`,
      { cause: error },
    );
  }
  if (error instanceof PublicResponseTimeoutError) {
    return new ImportUnreachableError(
      `连接 ${host} 后 ${error.timeoutMs}ms 内没有收到响应（${error.address}）。${remedy()}`,
      { cause: error },
    );
  }
  const code = errorCode(error);
  if (!code || !UNREACHABLE_CODES.has(code)) return null;
  return new ImportUnreachableError(`无法连接到 ${host}（${code}）。${remedy()}`, { cause: error });
}
