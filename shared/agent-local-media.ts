import type { DirectoryImportMediaKind } from './directory-import';

export const AGENT_LOCAL_MEDIA_CHANNEL = 'openchatcut:browse-local-media';
export const AGENT_LOCAL_MEDIA_MAX_ENTRIES = 10_000;

export interface AgentLocalMediaRequest {
  readonly path?: string;
  readonly query?: string;
  readonly kind?: DirectoryImportMediaKind;
  readonly recursive?: boolean;
  readonly offset?: number;
  readonly limit?: number;
}

export interface AgentLocalMediaEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: DirectoryImportMediaKind | 'directory';
  readonly size?: number;
  readonly modifiedAt?: number;
}

export interface AgentLocalMediaResult {
  readonly path: string;
  readonly entries: readonly AgentLocalMediaEntry[];
  readonly nextOffset: number | null;
  readonly truncated: boolean;
  readonly errors: readonly { path: string; error: string }[];
}

export function isAgentLocalMediaRequest(value: unknown): value is AgentLocalMediaRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (v.path === undefined || (typeof v.path === 'string' && v.path.length > 0 && v.path.length < 4096))
    && (v.query === undefined || (typeof v.query === 'string' && v.query.length <= 256))
    && (v.kind === undefined || (typeof v.kind === 'string' && ['video', 'audio', 'image', 'gif', 'svg'].includes(v.kind)))
    && (v.recursive === undefined || typeof v.recursive === 'boolean')
    && (v.offset === undefined || (Number.isInteger(v.offset) && Number(v.offset) >= 0 && Number(v.offset) <= AGENT_LOCAL_MEDIA_MAX_ENTRIES))
    && (v.limit === undefined || (Number.isInteger(v.limit) && Number(v.limit) >= 1 && Number(v.limit) <= 200));
}
