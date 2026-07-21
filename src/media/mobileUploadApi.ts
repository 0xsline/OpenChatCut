export interface MobileUploadRecord {
  id: string;
  name: string;
  mime: string;
  bytes: number;
  path: string;
  createdAt: number;
}

export interface MobileUploadSession {
  id: string;
  urls: string[];
  expiresAt: number;
  files: MobileUploadRecord[];
}

async function sessionRequest(path: string, init?: RequestInit): Promise<MobileUploadSession> {
  const response = await fetch(`/api/mobile-upload${path}`, init);
  const body = await response.json().catch(() => null) as (MobileUploadSession & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? `HTTP ${response.status}`);
  return body;
}

export function createMobileUploadSession(locale: 'zh' | 'en'): Promise<MobileUploadSession> {
  return sessionRequest(`/sessions?locale=${locale}`, { method: 'POST' });
}

export function getMobileUploadSession(id: string): Promise<MobileUploadSession> {
  return sessionRequest(`/sessions/${encodeURIComponent(id)}`);
}

export function closeMobileUploadSession(id: string): Promise<MobileUploadSession> {
  return sessionRequest(`/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
