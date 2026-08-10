import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { executeRun } from './executor';
import {
  cancelRun,
  createRun,
  deliverToolResult,
  failToolResult,
  getRun,
  pruneRuns,
  waitForRunEvents,
  type ServerRun,
} from './store';

const MAX_BODY_BYTES = 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function writeSse(res: ServerResponse, event: { id: number; type: string; data: unknown }): void {
  res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
}

function sseForRun(req: IncomingMessage, res: ServerResponse, run: ServerRun): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const lastEventId = Number(req.headers['last-event-id'] ?? 0);
  let closed = false;
  const close = (): void => {
    closed = true;
    run.waiters.delete(pump);
    res.end();
  };
  req.on('close', close);
  res.on('close', close);
  const pump = async (): Promise<void> => {
    while (!closed) {
      const pending = run.events.filter((event) => event.id > lastEventId);
      if (pending.length > 0) {
        for (const event of pending) writeSse(res, event);
        return;
      }
      const settled = run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled';
      if (settled) {
        writeSse(res, { id: run.eventCursor + 1, type: 'done', data: { status: run.status } });
        res.end();
        return;
      }
      await waitForRunEvents(run, run.eventCursor);
    }
  };
  run.waiters.add(pump);
  void pump();
}

export function agentRunsPlugin(): Plugin {
  return {
    name: 'openchatcut-agent-runs',
    configureServer(server) {
      server.middlewares.use('/api/agent-runs', async (req, res) => {
        // connect semantics: the mount prefix stays on req.url; strip it so
        // the route matchers below see bare paths (same as project-store).
        const mounted = req.url ?? '';
        const stripped = mounted.startsWith('/api/agent-runs')
          ? mounted.slice('/api/agent-runs'.length) || '/'
          : mounted;
        const url = new URL(stripped, 'http://localhost');
        const pathname = url.pathname;
        try {
          if (req.method === 'POST' && pathname === '/') {
            const body = await readJson(req);
            const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
            const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
            const model = typeof body.model === 'string' ? body.model.trim() : '';
            const messages = Array.isArray(body.messages) ? body.messages : [];
            const tools = Array.isArray(body.tools) ? body.tools : [];
            if (!projectId || !provider || !model || messages.length === 0) {
              sendJson(res, 400, { error: 'projectId, provider, model and messages are required' });
              return;
            }
            pruneRuns();
            const run = createRun({ projectId, provider, model });
            const origin = req.headers.host
              ? `http://${req.headers.host}`
              : 'http://127.0.0.1:5199';
            void executeRun(run, {
              messages: messages.map((m) => {
                const role = typeof m?.role === 'string' ? m.role : 'user';
                const content = typeof m?.content === 'string' ? m.content : String(m?.content ?? '');
                return { role: role === 'assistant' ? 'assistant' : 'user', content };
              }),
              provider,
              origin,
              tools: tools.flatMap((t) => {
                if (!t || typeof t !== 'object' || Array.isArray(t)) return [];
                if (!('name' in t) || typeof t.name !== 'string' || !t.name) return [];
                if (!('input_schema' in t) || !t.input_schema || typeof t.input_schema !== 'object') return [];
                const description = 'description' in t && typeof t.description === 'string'
                  ? t.description
                  : '';
                return [{ name: t.name, description, input_schema: t.input_schema }];
              }),
            });
            sendJson(res, 201, { id: run.id });
            return;
          }
          const runMatch = /^\/([0-9a-f-]{36})\/events$/.exec(pathname);
          if (req.method === 'GET' && runMatch) {
            const run = getRun(runMatch[1]!);
            if (!run) {
              sendJson(res, 404, { error: 'run not found' });
              return;
            }
            sseForRun(req, res, run);
            return;
          }
          const resultMatch = /^\/([0-9a-f-]{36})\/tool-result$/.exec(pathname);
          if (req.method === 'POST' && resultMatch) {
            const run = getRun(resultMatch[1]!);
            if (!run) {
              sendJson(res, 404, { error: 'run not found' });
              return;
            }
            const body = await readJson(req);
            const toolCallId = typeof body.toolCallId === 'string' ? body.toolCallId : '';
            if (!toolCallId) {
              sendJson(res, 400, { error: 'toolCallId is required' });
              return;
            }
            if (typeof body.error === 'string') {
              failToolResult(run, toolCallId, body.error);
            } else {
              deliverToolResult(run, toolCallId, body.result);
            }
            sendJson(res, 200, { ok: true });
            return;
          }
          const cancelMatch = /^\/([0-9a-f-]{36})\/cancel$/.exec(pathname);
          if (req.method === 'POST' && cancelMatch) {
            const run = getRun(cancelMatch[1]!);
            if (!run) {
              sendJson(res, 404, { error: 'run not found' });
              return;
            }
            cancelRun(run);
            sendJson(res, 200, { ok: true });
            return;
          }
          const getMatch = /^\/([0-9a-f-]{36})$/.exec(pathname);
          if (req.method === 'GET' && getMatch) {
            const run = getRun(getMatch[1]!);
            if (!run) {
              sendJson(res, 404, { error: 'run not found' });
              return;
            }
            sendJson(res, 200, {
              id: run.id,
              projectId: run.projectId,
              provider: run.provider,
              model: run.model,
              status: run.status,
              createdAt: run.createdAt,
              error: run.error,
              eventCount: run.events.length,
            });
            return;
          }
          sendJson(res, 404, { error: 'not found' });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
