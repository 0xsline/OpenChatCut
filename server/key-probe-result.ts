export interface ProbeResult {
  ok: boolean;
  message: string;
  status?: number;
  latencyMs?: number;
  models?: string[];
}

export function parseModelCatalog(bodyText: string): string[] {
  try {
    const body = JSON.parse(bodyText) as {
      data?: Array<{ id?: unknown; name?: unknown }>;
      models?: Array<{ id?: unknown; name?: unknown }>;
    };
    const rows = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
    return [...new Set(rows
      .map((row) => typeof row.id === 'string' ? row.id : typeof row.name === 'string' ? row.name : '')
      .map((id) => id.trim())
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** Cheaper Inference also lists image/video models; chat keeps text and untyped rows. */
export function parseTextModelCatalog(bodyText: string): string[] {
  try {
    const body = JSON.parse(bodyText) as { data?: Array<{ type?: unknown } | null> };
    if (!Array.isArray(body.data)) return parseModelCatalog(bodyText);
    const data = body.data.filter((row) => row != null && (row.type === undefined || row.type === 'text'));
    return parseModelCatalog(JSON.stringify({ data }));
  } catch {
    return [];
  }
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
