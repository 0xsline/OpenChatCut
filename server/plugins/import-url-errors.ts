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
import { localized } from '../ui-locale.ts';

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

const DIRECT_REMEDY = {
  zh: '该地址可能被当前网络屏蔽或需要代理。请检查网络，或在 设置 → Agent 模型 中配置 PROXY_URL；也可以换一个能直连的素材地址。',
  en: 'The host may be blocked on this network or need a proxy. Check the connection, set PROXY_URL under Settings → Agent model, or use a media URL that is reachable directly.',
  ru: 'Хост может быть заблокирован в этой сети или требовать прокси. Проверьте соединение, задайте PROXY_URL в Настройки → Модель агента или используйте адрес, доступный напрямую.',
  it: 'L\'host potrebbe essere bloccato su questa rete o richiedere un proxy. Controlla la connessione, imposta PROXY_URL in Impostazioni → Modello agente, oppure usa un URL raggiungibile direttamente.',
};
const PROXIED_REMEDY = {
  zh: '当前已经通过代理访问，代理也连不上这个主机。请检查代理规则，或换一个能访问的素材地址。',
  en: 'The request already went through the proxy and the proxy could not reach this host either. Check the proxy rules, or use a media URL it can reach.',
  ru: 'Запрос уже шёл через прокси, но и прокси не смог достучаться до хоста. Проверьте правила прокси или используйте другой адрес.',
  it: 'La richiesta è già passata dal proxy e nemmeno il proxy raggiunge questo host. Controlla le regole del proxy o usa un URL raggiungibile.',
};
const CONNECT_TIMEOUT = {
  zh: (host: string, ms: number, address: string) => `连接 ${host} 超时（${ms}ms 内未建立连接，${address}）。`,
  en: (host: string, ms: number, address: string) => `Connecting to ${host} timed out (no connection within ${ms}ms, ${address}). `,
  ru: (host: string, ms: number, address: string) => `Тайм-аут подключения к ${host} (нет соединения за ${ms}мс, ${address}). `,
  it: (host: string, ms: number, address: string) => `Connessione a ${host} scaduta (nessuna connessione entro ${ms}ms, ${address}). `,
};
const RESPONSE_TIMEOUT = {
  zh: (host: string, ms: number, address: string) => `连接 ${host} 后 ${ms}ms 内没有收到响应（${address}）。`,
  en: (host: string, ms: number, address: string) => `${host} accepted the connection but sent no response within ${ms}ms (${address}). `,
  ru: (host: string, ms: number, address: string) => `${host} принял соединение, но не ответил за ${ms}мс (${address}). `,
  it: (host: string, ms: number, address: string) => `${host} ha accettato la connessione ma non ha risposto entro ${ms}ms (${address}). `,
};
const UNREACHABLE = {
  zh: (host: string, code: string) => `无法连接到 ${host}（${code}）。`,
  en: (host: string, code: string) => `Could not connect to ${host} (${code}). `,
  ru: (host: string, code: string) => `Не удалось подключиться к ${host} (${code}). `,
  it: (host: string, code: string) => `Impossibile connettersi a ${host} (${code}). `,
};

/** Which of the two things the user can change is the one that matters right now, in the interface language. */
const remedy = (): string => localized(outboundProxyUrl() ? PROXIED_REMEDY : DIRECT_REMEDY);

/** Null when the failure is not a connectivity problem, so callers keep their own handling. */
export function unreachableImportError(error: unknown, remote: string): ImportUnreachableError | null {
  const host = hostOf(remote);
  if (error instanceof PublicConnectTimeoutError) {
    return new ImportUnreachableError(
      `${localized(CONNECT_TIMEOUT)(host, error.timeoutMs, error.address)}${remedy()}`,
      { cause: error },
    );
  }
  if (error instanceof PublicResponseTimeoutError) {
    return new ImportUnreachableError(
      `${localized(RESPONSE_TIMEOUT)(host, error.timeoutMs, error.address)}${remedy()}`,
      { cause: error },
    );
  }
  const code = errorCode(error);
  if (!code || !UNREACHABLE_CODES.has(code)) return null;
  return new ImportUnreachableError(`${localized(UNREACHABLE)(host, code)}${remedy()}`, { cause: error });
}
