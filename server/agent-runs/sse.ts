import type { IncomingMessage, ServerResponse } from 'node:http';
import { requestHeader } from './request';
import {
  isRunTerminal,
  replayWindow,
  waitForRunEvents,
  type ServerRun,
} from './store';
export const MAX_SSE_SUBSCRIBERS_PER_RUN = 4;
export const MAX_SSE_SUBSCRIBERS_TOTAL = 32;
let activeSseSubscriptions = 0;


export class CursorProtocolError extends Error {
  readonly status: 400 | 409 | 410;
  readonly details?: unknown;

  constructor(status: 400 | 409 | 410, message: string, details?: unknown) {
    super(message);
    this.name = 'CursorProtocolError';
    this.status = status;
    this.details = details;
  }
}

function parseCursor(value: string | null, label: string): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) {
    throw new CursorProtocolError(400, `${label} must be a non-negative integer`);
  }
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) {
    throw new CursorProtocolError(400, `${label} is outside the safe integer range`);
  }
  return cursor;
}

export function resolveCursor(req: IncomingMessage, url: URL, run: ServerRun): number {
  const after = parseCursor(url.searchParams.get('after'), 'after');
  const headerCursor = parseCursor(requestHeader(req, 'last-event-id'), 'Last-Event-ID');
  if (after !== null && headerCursor !== null && after !== headerCursor) {
    throw new CursorProtocolError(409, 'after and Last-Event-ID disagree');
  }
  const cursor = headerCursor ?? after ?? 0;
  const window = replayWindow(run);
  if (cursor < window.firstEventId - 1) {
    throw new CursorProtocolError(410, 'event cursor is no longer replayable', window);
  }
  if (cursor > window.lastEventId) {
    throw new CursorProtocolError(409, 'event cursor is ahead of the run', window);
  }
  return cursor;
}

function writeSse(
  res: ServerResponse,
  event: { id: number; type: string; data: unknown },
): boolean {
  return res.write(
    `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`,
  );
}

type RunSubscription = Readonly<{
  signal: AbortSignal;
  isClosed: () => boolean;
  close: () => void;
}>;

function subscribeToRun(
  req: IncomingMessage,
  res: ServerResponse,
  run: ServerRun,
): RunSubscription {
  let closed = false;
  const controller = new AbortController();
  run.subscriberCount += 1;
  activeSseSubscriptions += 1;
  const close = (): void => {
    if (closed) return;
    closed = true;
    run.subscriberCount = Math.max(0, run.subscriberCount - 1);
    activeSseSubscriptions = Math.max(0, activeSseSubscriptions - 1);
    controller.abort();
    if (!res.writableEnded) res.end();
  };
  req.once('close', close);
  res.once('close', close);
  return {
    signal: controller.signal,
    isClosed: () => closed,
    close,
  };
}

async function pumpRunEvents(
  res: ServerResponse,
  run: ServerRun,
  initialCursor: number,
  subscription: RunSubscription,
): Promise<void> {
  let cursor = initialCursor;
  while (!subscription.isClosed()) {
    for (const event of run.events) {
      if (event.id <= cursor) continue;
      if (subscription.isClosed()) return;
      if (!writeSse(res, event)) return subscription.close();
      cursor = event.id;
      if (event.type === 'done') return subscription.close();
    }
    if (isRunTerminal(run)) return subscription.close();
    await waitForRunEvents(run, cursor, subscription.signal);
  }
}

export function sseForRun(
  req: IncomingMessage,
  res: ServerResponse,
  run: ServerRun,
  initialCursor: number,
): void {
  if (run.subscriberCount >= MAX_SSE_SUBSCRIBERS_PER_RUN
    || activeSseSubscriptions >= MAX_SSE_SUBSCRIBERS_TOTAL) {
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '1',
    });
    res.end(JSON.stringify({ error: 'agent run event subscriber limit reached' }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const subscription = subscribeToRun(req, res, run);
  void pumpRunEvents(res, run, initialCursor, subscription).catch(subscription.close);
}
