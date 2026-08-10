// Phase C verify: semantic vector store routes writes/search/prune/clear to
// the project store (server → sqlite-vec) when reachable, keeps IndexedDB as
// the offline fallback. Node run: window mock for the transport; the IDB
// paths stay untouched (no indexedDB in Node).
import assert from 'node:assert/strict';
import { SEMANTIC_MODEL_VERSION } from './types';
import {
  clearSemanticVectors,
  pruneSemanticVectors,
  replaceAssetVectors,
  searchSemanticVectorsRemote,
} from './vectorStore';

const requests: Array<{ request: unknown }> = [];

function installTransport(): void {
  requests.length = 0;
  (globalThis as Record<string, unknown>).window = {
    openChatCutDesktop: {
      projectStore: async (request: unknown) => {
        requests.push({ request });
        return { ok: true };
      },
    },
  };
}

function uninstallTransport(): void {
  delete (globalThis as Record<string, unknown>).window;
}

function record(assetId: string, sampleTime: number): { scopeId: string; assetId: string; sampleTime: number; sourceRevision?: string; vector: Float32Array } {
  const vector = new Float32Array(512);
  vector[0] = 1;
  return { scopeId: 'project-a', assetId, sampleTime, sourceRevision: 'rev-1', vector };
}

async function main(): Promise<void> {
  installTransport();

  // ── replaceAssetVectors → server upsert request ──
  await replaceAssetVectors('project-a', 'asset-1', [record('asset-1', 0)]);
  assert.equal(requests.length, 1, 'replace must issue one server upsert');
  const upsert = requests[0]!.request as {
    operation: string;
    scopeId: string;
    assetId: string;
    samples: Array<{ vector: number[] }>;
  };
  assert.equal(upsert.operation, 'semantic-vectors-upsert');
  assert.equal(upsert.scopeId, 'project-a');
  assert.equal(upsert.assetId, 'asset-1');
  assert.equal(upsert.samples[0]!.vector.length, 512, 'Float32Array must be wire-converted to number[]');

  // ── remote search → server search request with the scope id ──
  // (searchSemanticVectorsRemote returns null when the server answers ok:true
  //  without semanticVectors — the browser then falls back to local ranking.)
  const remote = await searchSemanticVectorsRemote('project-a', new Float32Array(512));
  assert.equal(remote, null, 'a server response without hits must fall back to local');
  const searchReq = requests[1]!.request as { operation: string; scopeId: string; limit: number };
  assert.equal(searchReq.operation, 'semantic-vectors-search');
  assert.equal(searchReq.scopeId, 'project-a');
  assert.ok(searchReq.limit > 0);

  // ── server hit mapping: distance → cosine score, '' scene defaults → undefined ──
  (globalThis as Record<string, unknown>).window = {
    openChatCutDesktop: {
      projectStore: async (request: unknown) => {
        requests.push({ request });
        const search = request as { operation: string };
        if (search.operation === 'semantic-vectors-search') {
          return {
            semanticVectors: [
              { assetId: 'asset-1', sampleTime: 1.5, sourceRevision: 'rev-1', sceneId: '', sceneStart: -1, sceneEnd: -1, distance: 0.2 },
            ],
          };
        }
        return { ok: true };
      },
    },
  };
  const hits = await searchSemanticVectorsRemote('project-a', new Float32Array(512));
  assert.ok(hits && hits.length === 1, 'server hits must map to SemanticMatch[]');
  assert.equal(hits[0]!.assetId, 'asset-1');
  assert.equal(hits[0]!.sampleTime, 1.5);
  assert.equal(hits[0]!.sceneId, undefined, 'empty scene defaults must normalize to undefined');
  assert.ok(hits[0]!.score > 0.9, 'distance 0.2 → cosine score ≈ 0.98');
  assert.equal(hits[0]!.sourceRevision, 'rev-1');

  // ── prune + clear → server requests ──
  await pruneSemanticVectors('project-a', new Set(['asset-1']));
  const pruneReq = requests[requests.length - 1]!.request as { operation: string; validAssetIds: string[] };
  assert.equal(pruneReq.operation, 'semantic-vectors-prune');
  assert.deepEqual(pruneReq.validAssetIds, ['asset-1']);
  await clearSemanticVectors('project-a');
  const clearReq = requests[requests.length - 1]!.request as { operation: string; scopeId: string };
  assert.equal(clearReq.operation, 'semantic-vectors-clear');
  assert.equal(clearReq.scopeId, 'project-a');

  // ── offline: no transport → search falls back to local ranking ──
  // (the IDB write paths are browser-only and unchanged; Node has no IDB.)
  uninstallTransport();
  const offline = await searchSemanticVectorsRemote('project-a', new Float32Array(512));
  assert.equal(offline, null, 'offline must fall back to local ranking');

  console.log(`✓ semantic vectorStore verify: upsert/search/prune/clear routing + hit mapping + offline fallback passed (${SEMANTIC_MODEL_VERSION})`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
