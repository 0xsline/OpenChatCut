import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  isProjectStoreEntries,
  isProjectStoreKey,
  isProjectStoreRequest,
} from '../shared/project-store-validation.ts';
import type {
  ProjectStoreMutationResponse,
  ProjectDocumentMutationResponse,
  ProjectStoreRequest,
  ProjectStoreResponse,
} from '../shared/project-store-transport.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface ProjectStoreHttpOperations {
  compareAndSwapAgentRuntime(
    input: Extract<ProjectStoreRequest, { operation: 'agent-runtime-cas' }>,
  ): Promise<ProjectStoreMutationResponse>;
  compareAndSwapProjectDocument(
    input: Extract<ProjectStoreRequest, { operation: 'project-document-cas' }>,
  ): Promise<ProjectDocumentMutationResponse>;
  deleteEntry(key: string): Promise<void>;
  getEntry(key: string): Promise<ProjectStoreResponse>;
  mergeEntries(entries: Record<string, unknown>): Promise<{ entries: Record<string, unknown> }>;
  purgeProject(projectId: string): Promise<void>;
  readSnapshot(): Promise<ProjectStoreResponse>;
  setEntry(key: string, value: unknown): Promise<void>;
  rotateAgentSession(projectId: string): Promise<ProjectStoreMutationResponse>;
  updateAgentRunLease(
    input: Extract<ProjectStoreRequest, { operation: 'agent-run-lease' }>,
  ): Promise<ProjectStoreMutationResponse>;
  updateExportRecoveryLease(
    input: Extract<ProjectStoreRequest, { operation: 'export-recovery-lease' }>,
  ): Promise<ProjectStoreMutationResponse>;
  semanticVectorsUpsert(input: Extract<ProjectStoreRequest, { operation: 'semantic-vectors-upsert' }>): unknown;
  semanticVectorsSearch(input: Extract<ProjectStoreRequest, { operation: 'semantic-vectors-search' }>): unknown;
  semanticVectorsPrune(input: Extract<ProjectStoreRequest, { operation: 'semantic-vectors-prune' }>): unknown;
  semanticVectorsClear(input: Extract<ProjectStoreRequest, { operation: 'semantic-vectors-clear' }>): unknown;
}

const isProjectDocumentKey = (key: unknown): key is string =>
  typeof key === 'string' && /^project:[a-zA-Z0-9_-]{1,160}$/.test(key);

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('invalid JSON body');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function sendProjectStoreJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function entryKey(req: IncomingMessage): string | null {
  const key = new URL(req.url ?? '', 'http://localhost').searchParams.get('key');
  return isProjectStoreKey(key) ? key : null;
}

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<boolean> {
  if (req.method !== 'GET') return false;
  if (req.url === '/' || req.url === '') {
    sendProjectStoreJson(res, 200, await operations.readSnapshot());
    return true;
  }
  if (!req.url?.startsWith('/entry?')) return false;
  const key = entryKey(req);
  if (!key) throw new Error('invalid entry key');
  sendProjectStoreJson(res, 200, await operations.getEntry(key));
  return true;
}

async function handleAgentRuntimeCas(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  const body = await readBody(req);
  if (!isProjectStoreRequest(body) || body.operation !== 'agent-runtime-cas') {
    throw new Error('invalid agent runtime CAS request');
  }
  sendProjectStoreJson(res, 200, await operations.compareAndSwapAgentRuntime(body));
}

async function handleProjectDocumentCas(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  const body = await readBody(req);
  if (!isProjectStoreRequest(body) || body.operation !== 'project-document-cas') {
    throw new Error('invalid project document CAS request');
  }
  sendProjectStoreJson(res, 200, await operations.compareAndSwapProjectDocument(body));
}

async function handleAgentRunLease(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  const body = await readBody(req);
  if (!isProjectStoreRequest(body) || body.operation !== 'agent-run-lease') {
    throw new Error('invalid agent run lease request');
  }
  sendProjectStoreJson(res, 200, await operations.updateAgentRunLease(body));
}
async function handleExportRecoveryLease(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  const body = await readBody(req);
  if (!isProjectStoreRequest(body) || body.operation !== 'export-recovery-lease') {
    throw new Error('invalid export recovery lease request');
  }
  sendProjectStoreJson(res, 200, await operations.updateExportRecoveryLease(body));
}

async function handleAgentSessionRotate(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  const body = await readBody(req);
  if (!isProjectStoreRequest(body) || body.operation !== 'agent-session-rotate') {
    throw new Error('invalid Agent session rotation request');
  }
  sendProjectStoreJson(res, 200, await operations.rotateAgentSession(body.projectId));
}

async function handleMerge(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  const body = await readBody(req);
  if (!isProjectStoreEntries(body.entries)) throw new Error('invalid project store entries');
  const merged = await operations.mergeEntries(body.entries);
  const projects = merged.entries.projects;
  sendProjectStoreJson(res, 200, { version: 1, entries: projects === undefined ? {} : { projects } });
}

async function handleProjectPurge(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  const body = await readBody(req);
  if (!isProjectStoreRequest(body) || body.operation !== 'purge-project') {
    throw new Error('invalid project purge request');
  }
  await operations.purgeProject(body.projectId);
  sendProjectStoreJson(res, 200, { ok: true });
}

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<boolean> {
  if (req.method !== 'POST') return false;
  if (req.url === '/agent-runtime/cas') await handleAgentRuntimeCas(req, res, operations);
  else if (req.url === '/project-document/cas') await handleProjectDocumentCas(req, res, operations);
  else if (req.url === '/agent-runtime/lease') await handleAgentRunLease(req, res, operations);
  else if (req.url === '/export-recovery/lease') await handleExportRecoveryLease(req, res, operations);
  else if (req.url === '/agent-session/rotate') await handleAgentSessionRotate(req, res, operations);
  else if (req.url === '/merge') await handleMerge(req, res, operations);
  else if (req.url === '/project/purge') await handleProjectPurge(req, res, operations);
  else if (req.url === '/semantic-vectors/upsert') await handleSemanticVectors(req, res, operations, 'semantic-vectors-upsert');
  else if (req.url === '/semantic-vectors/search') await handleSemanticVectors(req, res, operations, 'semantic-vectors-search');
  else if (req.url === '/semantic-vectors/prune') await handleSemanticVectors(req, res, operations, 'semantic-vectors-prune');
  else if (req.url === '/semantic-vectors/clear') await handleSemanticVectors(req, res, operations, 'semantic-vectors-clear');
  else return false;
  return true;
}

async function handleEntryMutation(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<boolean> {
  if (req.method === 'PUT' && req.url === '/entry') {
    const body = await readBody(req);
    if (!isProjectStoreKey(body.key) || !Object.hasOwn(body, 'value')) throw new Error('invalid entry');
    if (isProjectDocumentKey(body.key)) {
      throw new Error('project document writes require authoritative ownership CAS');
    }
    await operations.setEntry(body.key, body.value);
    sendProjectStoreJson(res, 200, { ok: true });
    return true;
  }
  if (req.method !== 'DELETE' || !req.url?.startsWith('/entry?')) return false;
  const key = entryKey(req);
  if (!key) throw new Error('invalid entry key');
  await operations.deleteEntry(key);
  sendProjectStoreJson(res, 200, { ok: true });
  return true;
}

async function handleSemanticVectors(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
  operation: 'semantic-vectors-upsert' | 'semantic-vectors-search' | 'semantic-vectors-prune' | 'semantic-vectors-clear',
): Promise<void> {
  const body = await readBody(req);
  const dispatch: Record<string, (input: never) => unknown> = {
    'semantic-vectors-upsert': (input) => operations.semanticVectorsUpsert(input as never),
    'semantic-vectors-search': (input) => operations.semanticVectorsSearch(input as never),
    'semantic-vectors-prune': (input) => operations.semanticVectorsPrune(input as never),
    'semantic-vectors-clear': (input) => operations.semanticVectorsClear(input as never),
  };
  sendProjectStoreJson(res, 200, await dispatch[operation](body as never));
}

export async function routeProjectStoreRequest(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  if (await handleGet(req, res, operations)) return;
  if (await handlePost(req, res, operations)) return;
  if (await handleEntryMutation(req, res, operations)) return;
  sendProjectStoreJson(res, 405, { error: 'method not allowed' });
}
