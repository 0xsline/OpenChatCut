// One-click external client connection: writes the OpenChatCut MCP endpoint
// and token into well-known local client config files. Only the `openchatcut`
// entry is touched; every other server in each file is preserved. JSON files
// are merged atomically (write-to-temp + rename) and never clobbered when the
// existing content fails to parse.
import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const CONNECT_CLIENTS = ['claude', 'codex', 'cursor', 'antigravity'] as const;
export type ConnectClient = (typeof CONNECT_CLIENTS)[number];

export type ClientConnectResult =
  | { ok: true; paths: string[] }
  | { ok: false; error: 'invalid-client' | 'invalid-token' | 'config-parse-error' | 'config-write-error' | 'codex-cli-failed'; detail?: string };

export interface ClientConnectOptions {
  /** Base directory that stands in for the user home. Defaults to os.homedir(). */
  baseDir?: string;
  /** Codex CLI override (tests inject a stub here). Defaults to auto-detection. */
  codexBin?: string;
}

const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const TOKEN_ENV_VAR = 'OPENCHATCUT_MCP_TOKEN';
const CODEX_BIN_FALLBACKS = ['.local/bin/codex', '/Applications/ChatGPT.app/Contents/Resources/codex'];

function displayPath(baseDir: string, file: string): string {
  const rel = path.relative(baseDir, file);
  return rel.startsWith('..') ? file : `~/${rel.split(path.sep).join('/')}`;
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.occ-connect-tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, file);
}

type MergeFailure = { ok: false; error: 'config-parse-error' | 'config-write-error'; detail?: string };

async function mergeJsonConfig(
  file: string,
  build: (root: Record<string, unknown>) => void,
): Promise<{ ok: true } | MergeFailure> {
  let root: Record<string, unknown> = {};
  try {
    const text = await readFile(file, 'utf8');
    if (text.trim()) {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, error: 'config-parse-error', detail: file };
      }
      root = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { ok: false, error: 'config-parse-error', detail: file };
    }
  }
  const servers = root.mcpServers;
  if (servers !== undefined && (typeof servers !== 'object' || servers === null || Array.isArray(servers))) {
    return { ok: false, error: 'config-parse-error', detail: 'mcpServers' };
  }
  build(root);
  try {
    await writeAtomic(file, `${JSON.stringify(root, null, 2)}\n`);
  } catch (error) {
    return { ok: false, error: 'config-write-error', detail: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
}

function httpEntry(endpoint: string, token: string): Record<string, unknown> {
  return { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${token}` } };
}

async function connectJsonClient(
  file: string,
  entry: Record<string, unknown>,
): Promise<{ ok: true; paths: [string] } | MergeFailure> {
  const result = await mergeJsonConfig(file, (root) => {
    const servers = (root.mcpServers as Record<string, unknown> | undefined) ?? {};
    servers.openchatcut = entry;
    root.mcpServers = servers;
  });
  if (!result.ok) return result;
  return { ok: true, paths: [file] };
}

function runCodex(bin: string, endpoint: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['mcp', 'add', 'openchatcut', '--url', endpoint, '--bearer-token-env-var', TOKEN_ENV_VAR], { env });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, stderr: stderr || 'spawn failed' });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

async function connectCodex(endpoint: string, token: string, baseDir: string, codexBin?: string): Promise<ClientConnectResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: baseDir, CODEX_HOME: path.join(baseDir, '.codex') };
  const candidates = codexBin
    ? [codexBin]
    : ['codex', ...CODEX_BIN_FALLBACKS.map((relative) => (relative.startsWith('/') ? relative : path.join(baseDir, relative)))];
  let lastStderr = 'codex CLI not found';
  for (const bin of candidates) {
    const { code, stderr } = await runCodex(bin, endpoint, env);
    if (code === 0) {
      const zshrc = path.join(baseDir, '.zshrc');
      const wanted = `export ${TOKEN_ENV_VAR}='${token}'`;
      try {
        let text = '';
        try {
          text = await readFile(zshrc, 'utf8');
        } catch {
          /* first connection - file does not exist yet */
        }
        const lines = text.split('\n');
        const idx = lines.findIndex((line) => /^\s*(export\s+)?OPENCHATCUT_MCP_TOKEN=/.test(line));
        if (idx >= 0) {
          if (lines[idx].trim() !== wanted) lines[idx] = wanted;
          await writeAtomic(zshrc, lines.join('\n'));
        } else {
          const suffix = text && !text.endsWith('\n') ? '\n' : '';
          await writeAtomic(zshrc, `${text}${suffix}# OpenChatCut MCP token (added by OpenChatCut)\n${wanted}\n`);
        }
      } catch (error) {
        return { ok: false, error: 'config-write-error', detail: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true, paths: [path.join(baseDir, '.codex', 'config.toml'), zshrc] };
    }
    lastStderr = stderr || `exit code ${code}`;
  }
  return { ok: false, error: 'codex-cli-failed', detail: lastStderr.slice(-200) };
}

export async function connectExternalClient(
  client: string,
  endpoint: string,
  token: string,
  options: ClientConnectOptions = {},
): Promise<ClientConnectResult> {
  if (!CONNECT_CLIENTS.includes(client as ConnectClient)) {
    return { ok: false, error: 'invalid-client' };
  }
  if (typeof endpoint !== 'string' || !/^https?:\/\//.test(endpoint) || !TOKEN_PATTERN.test(token)) {
    return { ok: false, error: 'invalid-token' };
  }
  const baseDir = options.baseDir ?? homedir();
  if (client === 'codex') {
    const result = await connectCodex(endpoint, token, baseDir, options.codexBin);
    if (!result.ok) return result;
    return { ok: true, paths: result.paths.map((file) => displayPath(baseDir, file)) };
  }
  const files: Record<'claude' | 'cursor' | 'antigravity', { file: string; entry: Record<string, unknown> }> = {
    claude: { file: path.join(baseDir, '.claude.json'), entry: httpEntry(endpoint, token) },
    cursor: { file: path.join(baseDir, '.cursor', 'mcp.json'), entry: httpEntry(endpoint, token) },
    antigravity: {
      file: path.join(baseDir, '.gemini', 'antigravity', 'mcp_config.json'),
      entry: { httpUrl: endpoint, headers: { Authorization: `Bearer ${token}` } },
    },
  };
  const target = files[client as 'claude' | 'cursor' | 'antigravity'];
  const result = await connectJsonClient(target.file, target.entry);
  if (!result.ok) return result;
  return { ok: true, paths: [displayPath(baseDir, target.file)] };
}
