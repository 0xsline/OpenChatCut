import { SERVER_RUN_CAPABILITY_HEADER } from './serverRunProtocol';

export interface ServerRunEventStream {
  onopen: ((event: Event) => void) | null;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void;
  close(): void;
}

export interface ServerRunEventStreamInput {
  readonly projectId: string;
  readonly runId: string;
  readonly capability: string;
  readonly after: number;
  readonly fetch?: typeof fetch;
}

/** A single fetch-backed SSE connection. Reconnection remains owned by the hook session. */
export class FetchServerRunEventStream extends EventTarget implements ServerRunEventStream {
  onopen: ((event: Event) => void) | null = null;

  private readonly abort = new AbortController();
  private readonly fetchImpl: typeof fetch;
  private readonly url: string;
  private readonly capability: string;
  private readonly initialCursor: number;
  private closed = false;
  private terminalEventSeen = false;
  private lastEventId: string;
  private line = '';
  private previousWasCr = false;
  private eventType = '';
  private dataLines: string[] = [];

  constructor(input: ServerRunEventStreamInput) {
    super();
    if (!Number.isSafeInteger(input.after) || input.after < 0) {
      throw new Error('Server run event cursor must be a non-negative safe integer.');
    }
    this.fetchImpl = input.fetch ?? fetch;
    this.capability = input.capability;
    this.initialCursor = input.after;
    this.lastEventId = String(input.after);
    this.url = `/api/agent-runs/${input.runId}/events?projectId=${encodeURIComponent(input.projectId)}&after=${input.after}`;
    queueMicrotask(() => { void this.connect(); });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    try {
      const fetchImpl = this.fetchImpl;
      const response = await fetchImpl(this.url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          Accept: 'text/event-stream',
          'Last-Event-ID': String(this.initialCursor),
          [SERVER_RUN_CAPABILITY_HEADER]: this.capability,
        },
        signal: this.abort.signal,
      });
      if (this.closed) return;
      if (!response.ok || !response.body) {
        throw new Error(`server run events failed: HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!contentType.startsWith('text/event-stream')) {
        throw new Error('server run events returned an invalid content type');
      }
      const opened = new Event('open');
      this.dispatchEvent(opened);
      this.onopen?.(opened);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        this.consume(decoder.decode(value, { stream: true }));
      }
      if (!this.closed) this.consume(decoder.decode());
      if (!this.closed && !this.terminalEventSeen) this.dispatchEvent(new Event('error'));
    } catch (error) {
      if (!this.closed && !(error instanceof DOMException && error.name === 'AbortError')) {
        this.dispatchEvent(new Event('error'));
      }
    }
  }

  private consume(chunk: string): void {
    for (const character of chunk) {
      if (this.previousWasCr) {
        this.previousWasCr = false;
        if (character === '\n') continue;
      }
      if (character === '\r' || character === '\n') {
        this.consumeLine(this.line);
        this.line = '';
        this.previousWasCr = character === '\r';
      } else {
        this.line += character;
      }
    }
  }

  private consumeLine(line: string): void {
    if (!line) {
      this.dispatchMessage();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.eventType = value;
    else if (field === 'data') this.dataLines.push(value);
    else if (field === 'id' && !value.includes('\0')) this.lastEventId = value;
  }

  private dispatchMessage(): void {
    const type = this.eventType || 'message';
    this.eventType = '';
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    if (type === 'done') this.terminalEventSeen = true;
    this.dispatchEvent(new MessageEvent(type, { data, lastEventId: this.lastEventId }));
  }
}

export function openServerRunEventStream(input: ServerRunEventStreamInput): ServerRunEventStream {
  return new FetchServerRunEventStream(input);
}
