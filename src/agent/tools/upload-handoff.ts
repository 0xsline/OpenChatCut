import { editorCredentialHeaders } from '../editor-credential';

const METHOD = 'POST' as const;

type UploadAssetType = 'audio' | 'gif' | 'image' | 'svg' | 'video';
export interface MintedUploadHandoff {
  uploadUrl: string;
  expiresAt: number;
  expiresInSeconds: number;
  allowedMethods: readonly ['POST'];
}


function trustedEditorOrigin(): string {
  const origin = globalThis.location?.origin;
  if (typeof origin !== 'string') throw new Error('editor origin is unavailable');
  const parsed = new URL(origin);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error('editor origin is invalid');
  }
  return origin;
}

function parseMintResponse(
  value: unknown,
  expected: {
    sessionId: string;
    assetId: string;
    assetType: UploadAssetType;
    filename: string;
    projectId: string;
  },
): MintedUploadHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('upload handoff mint returned an invalid response');
  }
  const candidate = value as Partial<MintedUploadHandoff>;
  if (typeof candidate.uploadUrl !== 'string' || !Number.isSafeInteger(candidate.expiresAt)
    || candidate.expiresAt! <= Date.now() || !Number.isSafeInteger(candidate.expiresInSeconds)
    || candidate.expiresInSeconds! <= 0 || !Array.isArray(candidate.allowedMethods)
    || candidate.allowedMethods.length !== 1 || candidate.allowedMethods[0] !== METHOD) {
    throw new Error('upload handoff mint returned an invalid response');
  }
  const url = new URL(candidate.uploadUrl, 'http://localhost');
  if (!candidate.uploadUrl.startsWith('/upload?') || url.pathname !== '/upload'
    || url.searchParams.get('assetId') !== expected.assetId
    || url.searchParams.get('sessionId') !== expected.sessionId
    || url.searchParams.get('assetType') !== expected.assetType
    || url.searchParams.get('name') !== expected.filename
    || url.searchParams.get('projectId') !== expected.projectId
    || !(url.searchParams.get('handoff') ?? '')) {
    throw new Error('upload handoff mint returned an invalid response');
  }
  return { ...(candidate as MintedUploadHandoff), uploadUrl: new URL(candidate.uploadUrl, trustedEditorOrigin()).href };
}

export async function mintUploadHandoff(
  sessionId: string,
  assetId: string,
  assetType: UploadAssetType,
  filename: string,
  projectId: string,
  contentType: string,
  expectedBytes: number,
): Promise<MintedUploadHandoff> {
  const body = {
    sessionId, assetId, assetType, filename, projectId,
    method: METHOD, contentType, expectedBytes,
  };
  const response = await fetch('/api/external-agent/import-token', {
    method: 'POST',
    headers: await editorCredentialHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`upload handoff mint failed: HTTP ${response.status}`);
  return parseMintResponse(
    await response.json(),
    { sessionId, assetId, assetType, filename, projectId },
  );
}
