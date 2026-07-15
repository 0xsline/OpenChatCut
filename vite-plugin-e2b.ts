// Server-side proxy to an e2b cloud sandbox. Holds E2B_API_KEY (never shipped to the
// browser) and exposes POST /e2b/run: write optional input files, run one shell command,
// read optional output files, return stdout/stderr/exitCode. This is our own sandbox for
// running skill-shipped scripts (ffmpeg / node / python) — the portable stand-in for the
// native Agent Skills code-execution container, which our relay can't reach. The sandbox
// cannot touch the editor; results come back and the agent applies them via local tools.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { Sandbox } from '@e2b/code-interpreter';

interface E2bOptions {
  apiKey: string;
}

interface E2bFile {
  path: string;
  content: string;
}

interface E2bRequest {
  command: string;
  files?: E2bFile[];
  outputs?: string[];
  timeoutMs?: number;
}

const MAX_BODY = 25_000_000; // allow small media files written into the sandbox
const MAX_TIMEOUT = 300_000;

async function readJson(req: IncomingMessage): Promise<E2bRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_BODY) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as E2bRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

// e2b throws CommandExitError on a non-zero exit — that's a normal result (the command
// ran and failed), so pull stdout/stderr/exitCode off it rather than treating it as an
// infra error. Re-throw anything without an exitCode (connection/sandbox failure).
function asCommandResult(error: unknown): { stdout: string; stderr: string; exitCode: number } {
  const e = error as { stdout?: string; stderr?: string; exitCode?: number };
  if (typeof e.exitCode === 'number') return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', exitCode: e.exitCode };
  throw error;
}

export function e2bPlugin(options: E2bOptions): Plugin {
  return {
    name: 'chatcut-e2b',
    configureServer(server) {
      server.middlewares.use('/e2b/run', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        let sandbox: Sandbox | undefined;
        try {
          if (!options.apiKey) throw new Error('e2b sandbox is not configured. Set E2B_API_KEY in .env.local.');
          const input = await readJson(req);
          const command = String(input.command ?? '').trim();
          if (!command) throw new Error('command is required');

          sandbox = await Sandbox.create({ apiKey: options.apiKey, timeoutMs: Math.min(input.timeoutMs ?? 120_000, MAX_TIMEOUT) });
          for (const file of input.files ?? []) {
            await sandbox.files.write(file.path, file.content);
          }

          let result: { stdout: string; stderr: string; exitCode: number };
          try {
            const r = await sandbox.commands.run(command);
            result = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode ?? 0 };
          } catch (error) {
            result = asCommandResult(error);
          }

          const outputs: Record<string, string> = {};
          for (const path of input.outputs ?? []) {
            try { outputs[path] = await sandbox.files.read(path); } catch { outputs[path] = ''; }
          }

          sendJson(res, 200, { ...result, outputs });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[e2b] ${message}`);
          sendJson(res, 400, { error: message });
        } finally {
          if (sandbox) { try { await sandbox.kill(); } catch { /* sandbox already gone */ } }
        }
      });
    },
  };
}
