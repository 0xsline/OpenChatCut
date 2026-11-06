import { currentAgentSessionGeneration } from '../../persist/agentSessionGeneration';

// The persisted chat generation changes when clearAgentSessionContext succeeds.
// Only the opaque UUID leaves this machine, never the project id or user text.
const pending = new Map<string, Promise<string>>();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function webSearchSessionId(projectId: string | undefined): Promise<string | undefined> {
  // Standalone callers without a chat owner omit MCP's optional session argument.
  if (!projectId) return undefined;
  const generation = await currentAgentSessionGeneration(projectId);
  const key = `cc.webSearchSession.${projectId}.${generation}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const create = async () => {
    try {
      const saved = localStorage.getItem(key);
      if (saved && UUID.test(saved)) return saved;
    } catch { /* Storage is optional; the in-memory conversation cache still works. */ }
    const id = crypto.randomUUID();
    try { localStorage.setItem(key, id); } catch { /* Private browsing / storage full. */ }
    return id;
  };
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const result = locks ? locks.request(key, create) : create();
  pending.set(key, result);
  result.catch(() => { pending.delete(key); });
  return result;
}
