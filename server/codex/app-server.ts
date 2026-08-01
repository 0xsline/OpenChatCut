import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { CodexLoginMode } from '../../shared/codex-agent.ts';
import { codexCommand } from './command.ts';

const INITIALIZE_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
const CODEX_HOME = join(homedir(), '.openchatcut', 'codex');
export const CODEX_DISABLED_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'browser_use_full_cdp_access',
  'code_mode_host',
  'computer_use',
  'enable_mcp_apps',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'plugin_sharing',
  'plugins',
  'remote_plugin',
  'shell_snapshot',
  'shell_tool',
  'skill_mcp_dependency_install',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'workspace_dependencies',
] as const;
const APP_SERVER_ARGS: readonly string[] = [
  ...CODEX_DISABLED_FEATURES.flatMap((feature) => ['-c', `features.${feature}=false`]),
  '-c', 'tools.view_image=false',
  '-c', 'web_search=disabled',
  'app-server', '--listen', 'stdio://',
];
const CHILD_ENV_NAMES = [
  'PATH', 'Path', 'PATHEXT',
  'HOME', 'USER', 'LOGNAME', 'USERPROFILE', 'USERNAME',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'SystemRoot', 'WINDIR', 'COMSPEC', 'ComSpec',
  'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY',
  'CODEX_CA_CERTIFICATE', 'NO_COLOR', 'FORCE_COLOR',
] as const;


export interface CodexNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface CodexServerRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: Record<string, unknown>;
  respond(result: unknown): boolean;
  reject(code: number, message: string): boolean;
}

interface RpcOptions {
  readonly timeoutMs?: number;
  readonly restartOnTimeout?: boolean;
  readonly signal?: AbortSignal;
}

interface PendingRpc {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanupAbort: () => void;
}

type NotificationHandler = (notification: CodexNotification) => void;
type ServerRequestHandler = (request: CodexServerRequest) => boolean;
type ExitHandler = (error: Error) => void;

export class CodexTimeoutError extends Error {
  readonly method: string;

  constructor(method: string) {
    super(`Codex app-server timed out during ${method}.`);
    this.name = 'CodexTimeoutError';
    this.method = method;
  }
}

export class CodexProcessError extends Error {
  constructor(message = 'Codex app-server is unavailable.') {
    super(message);
    this.name = 'CodexProcessError';
  }
}

export class CodexRpcError extends Error {
  readonly method: string;
  readonly code: number | null;

  constructor(method: string, code: number | null) {
    super(`Codex app-server rejected ${method}.`);
    this.name = 'CodexRpcError';
    this.method = method;
    this.code = code;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function childEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { CODEX_HOME };
  for (const name of CHILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function safeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return 15_000;
  return Math.max(250, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.floor(value!)));
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private runtimeCwd: string | null = null;
  private startPromise: Promise<void> | null = null;
  private initialized = false;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRpc>();
  private readonly notifications = new Set<NotificationHandler>();
  private readonly serverRequests = new Set<ServerRequestHandler>();
  private readonly exits = new Set<ExitHandler>();
  private readonly loginIds = new Set<string>();
  private readonly completedLoginIds = new Set<string>();

  readonly executablePath: string;
  private readonly argsPrefix: readonly string[];

  constructor(executablePath: string, argsPrefix: readonly string[] = []) {
    this.executablePath = executablePath;
    this.argsPrefix = argsPrefix;
  }

  get loginPending(): boolean {
    return this.loginIds.size > 0;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequests.add(handler);
    return () => this.serverRequests.delete(handler);
  }

  onExit(handler: ExitHandler): () => void {
    this.exits.add(handler);
    return () => this.exits.delete(handler);
  }

  async request(method: string, params: unknown, options: RpcOptions = {}): Promise<unknown> {
    await this.ensureStarted();
    return this.rawRequest(method, params, options);
  }

  async startLogin(mode: CodexLoginMode): Promise<unknown> {
    const response = await this.request('account/login/start', { type: mode }, { timeoutMs: 15_000 });
    const loginId = record(response)?.loginId;
    if (typeof loginId === 'string') {
      if (this.completedLoginIds.delete(loginId)) this.loginIds.delete(loginId);
      else this.loginIds.add(loginId);
    }
    return response;
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.request('account/login/cancel', { loginId }, { timeoutMs: 10_000 });
    this.loginIds.delete(loginId);
    this.completedLoginIds.delete(loginId);
  }

  async cancelPendingLogins(): Promise<void> {
    await Promise.all([...this.loginIds].map((loginId) => this.cancelLogin(loginId)));
  }

  async logout(): Promise<void> {
    await this.request('account/logout', {}, { timeoutMs: 10_000 });
    this.loginIds.clear();
    this.completedLoginIds.clear();
  }

  restart(message = 'Codex app-server was restarted.'): void {
    const child = this.child;
    if (child) this.resetProcess(child, new CodexProcessError(message));
  }

  stop(): void {
    this.restart('Codex app-server stopped.');
  }

  private async ensureStarted(): Promise<void> {
    if (this.child && this.initialized) return;
    if (this.startPromise) return this.startPromise;
    const starting = this.startProcess();
    this.startPromise = starting;
    try {
      await starting;
    } finally {
      if (this.startPromise === starting) this.startPromise = null;
    }
  }

  private async startProcess(): Promise<void> {
    await mkdir(CODEX_HOME, { recursive: true, mode: 0o700 });
    const runtimeCwd = await mkdtemp(join(tmpdir(), 'openchatcut-codex-runtime-'));
    const command = codexCommand(this.executablePath, [...this.argsPrefix, ...APP_SERVER_ARGS]);
    const child = spawn(command.executable, command.args, {
      cwd: runtimeCwd,
      env: childEnvironment(),
      shell: false,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.runtimeCwd = runtimeCwd;
    this.attachProcess(child);
    try {
      await this.rawRequest('initialize', {
        clientInfo: { name: 'openchatcut', title: 'OpenChatCut', version: '1' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, { timeoutMs: INITIALIZE_TIMEOUT_MS, restartOnTimeout: true });
      this.writeMessage({ method: 'initialized' });
      this.initialized = true;
    } catch (error) {
      this.resetProcess(child, error instanceof Error ? error : new CodexProcessError());
      throw error;
    }
  }

  private attachProcess(child: ChildProcessWithoutNullStreams): void {
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => this.handleLine(child, line));
    child.stderr.resume();
    child.once('error', () => this.handleProcessExit(child));
    child.once('close', () => this.handleProcessExit(child));
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (this.child !== child || !line.trim()) return;
    if (Buffer.byteLength(line) > MAX_PROTOCOL_LINE_BYTES) {
      this.resetProcess(child, new CodexProcessError('Codex app-server sent an oversized response.'));
      return;
    }
    try {
      this.routeMessage(JSON.parse(line));
    } catch {
      this.resetProcess(child, new CodexProcessError('Codex app-server sent an invalid response.'));
    }
  }

  private routeMessage(value: unknown): void {
    const message = record(value);
    if (!message) throw new Error('invalid message');
    if ((typeof message.id === 'number' || typeof message.id === 'string') && typeof message.method === 'string') {
      this.handleServerRequest(message.id, message.method, record(message.params) ?? {});
      return;
    }
    if (typeof message.id === 'number') {
      this.handleResponse(message.id, message);
      return;
    }
    if (typeof message.method === 'string') this.handleNotification(message.method, record(message.params) ?? {});
  }

  private handleResponse(id: number, message: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanupAbort();
    const rpcError = record(message.error);
    if (rpcError) {
      pending.reject(new CodexRpcError(pending.method, typeof rpcError.code === 'number' ? rpcError.code : null));
      return;
    }
    pending.resolve(message.result);
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'account/login/completed') {
      if (typeof params.loginId === 'string') {
        this.loginIds.delete(params.loginId);
        this.completedLoginIds.add(params.loginId);
      } else {
        this.loginIds.clear();
      }
    }
    for (const handler of this.notifications) {
      try { handler({ method, params }); } catch { /* isolate subscribers */ }
    }
  }

  private handleServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.writeMessage({ id, result: { decision: 'decline' } });
      return;
    }
    if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
      this.writeMessage({ id, result: { decision: { denied: { rejection: 'Use the OpenChatCut proposal review.' } } } });
      return;
    }
    const request = this.serverRequest(id, method, params);
    for (const handler of this.serverRequests) {
      try {
        if (handler(request)) return;
      } catch {
        request.reject(-32603, 'OpenChatCut could not handle this request.');
        return;
      }
    }
    request.reject(-32601, 'Method not supported by OpenChatCut.');
  }

  private serverRequest(id: number | string, method: string, params: Record<string, unknown>): CodexServerRequest {
    let settled = false;
    const settle = (payload: unknown): boolean => {
      if (settled) return false;
      settled = true;
      return this.writeMessage(payload);
    };
    return {
      id,
      method,
      params,
      respond: (result) => settle({ id, result }),
      reject: (code, message) => settle({ id, error: { code, message } }),
    };
  }

  private rawRequest(method: string, params: unknown, options: RpcOptions): Promise<unknown> {
    if (!this.child) return Promise.reject(new CodexProcessError());
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error('Request aborted.'));
    const id = this.nextRequestId++;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const cleanupAbort = this.bindAbort(id, options.signal);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      cleanupAbort();
      reject(new CodexTimeoutError(method));
      if (options.restartOnTimeout && this.child) this.resetProcess(this.child, new CodexTimeoutError(method));
    }, safeTimeout(options.timeoutMs));
    timer.unref();
    this.pending.set(id, { method, resolve, reject, timer, cleanupAbort });
    if (options.signal?.aborted) {
      this.rejectPending(id, options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Request aborted.'));
      return promise;
    }
    if (!this.pending.has(id) || !this.writeMessage({ id, method, params })) {
      this.rejectPending(id, new CodexProcessError());
    }
    return promise;
  }

  private bindAbort(id: number, signal: AbortSignal | undefined): () => void {
    if (!signal) return () => {};
    const onAbort = () => {
      this.rejectPending(id, signal.reason instanceof Error ? signal.reason : new Error('Request aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  private rejectPending(id: number, error: Error): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.cleanupAbort();
    pending.reject(error);
  }

  private writeMessage(message: unknown): boolean {
    const child = this.child;
    if (!child || child.stdin.destroyed || !child.stdin.writable) return false;
    try {
      child.stdin.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  private handleProcessExit(child: ChildProcessWithoutNullStreams): void {
    if (this.child === child) this.resetProcess(child, new CodexProcessError());
  }

  private resetProcess(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child !== child) return;
    this.child = null;
    this.initialized = false;
    this.loginIds.clear();
    this.completedLoginIds.clear();
    for (const id of [...this.pending.keys()]) this.rejectPending(id, error);
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const forceKill = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 1_500);
    forceKill.unref();
    const runtimeCwd = this.runtimeCwd;
    this.runtimeCwd = null;
    if (runtimeCwd) void rm(runtimeCwd, { recursive: true, force: true }).catch(() => {});
    for (const handler of this.exits) {
      try { handler(error); } catch { /* isolate subscribers */ }
    }
  }
}
