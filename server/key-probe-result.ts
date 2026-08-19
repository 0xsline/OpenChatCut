export interface ProbeResult {
  ok: boolean;
  message: string;
  status?: number;
  latencyMs?: number;
  models?: string[];
}

export function sanitizeProbeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 140);
}

/** Convert a provider response into a user-facing connectivity conclusion. */
export function classifyStatus(status: number, bodyText: string): ProbeResult {
  if (status === 401 || status === 403) {
    return { ok: false, status, message: `鉴权失败（HTTP ${status}）· Key 无效、过期或无此接口权限` };
  }
  if (status === 404) {
    return { ok: false, status, message: '探测端点 404 · Base URL 可能填错（或该服务不认此探测路径）' };
  }
  if (status === 429) {
    return { ok: true, status, message: '鉴权通过（HTTP 429 限流，说明 Key 有效）' };
  }
  const detail = sanitizeProbeText(bodyText);
  return { ok: false, status, message: `HTTP ${status}${detail ? ` · ${detail}` : ''}` };
}

/** Distinguish transport failures from rejected credentials. */
export function networkMessage(error: unknown): string {
  const raw = error instanceof Error
    ? `${error.name}: ${error.message}${error.cause instanceof Error ? `（${error.cause.message}）` : ''}`
    : String(error);
  if (/timeout|abort/i.test(raw)) {
    return '连接超时 · 服务不可达或网络受限（可能需代理），不代表 Key 错误';
  }
  return `网络不可达 · ${sanitizeProbeText(raw)} · 本机连不上该服务（可能需代理），不代表 Key 错误`;
}
