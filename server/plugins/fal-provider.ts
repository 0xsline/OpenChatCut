import { isFalEndpoint } from '../../shared/fal-models.ts';
import type { FalRequest } from './fal-catalog-input.ts';
interface QueueClient {
  queue: {
    submit: (endpoint: string, options: { input: Record<string, unknown> }) => Promise<{ request_id: string }>;
    subscribeToStatus: (endpoint: string, options: { requestId: string; mode: 'polling'; pollInterval: number; timeout: number; logs: boolean }) => Promise<unknown>;
    result: (endpoint: string, options: { requestId: string }) => Promise<{ data: unknown }>;
  };
}
export function falTask(id: string): { endpoint: string; requestId: string } {
  try {
    if (!id.startsWith('fal:')) throw new Error();
    const value = JSON.parse(id.slice(4));
    if ((!isFalEndpoint(value.endpoint) && !/^(bytedance\/seedance-2\.0\/(text|image|reference)-to-video|fal-ai\/kling-video\/(v3|o3)\/(standard|pro)\/(text|image|reference)-to-video|fal-ai\/nano-banana-2(?:\/edit)?)$/.test(value.endpoint))
      || typeof value.requestId !== 'string' || !value.requestId) throw new Error();
    return { endpoint: value.endpoint, requestId: value.requestId };
  } catch { throw new Error('Invalid Fal task checkpoint'); }
}

/** Persist the request ID before polling. Resuming never submits a paid request. */
export async function runFalQueue(
  client: QueueClient,
  request: FalRequest,
  register: (provider: string, taskId: string) => Promise<void>,
  existingTaskId?: string,
): Promise<unknown> {
  let task = existingTaskId ? falTask(existingTaskId) : undefined;
  if (!task) {
    const submitted = await client.queue.submit(request.endpoint, { input: request.input });
    if (!submitted.request_id) throw new Error('Fal did not return a request ID');
    task = { endpoint: request.endpoint, requestId: submitted.request_id };
    await register('fal', `fal:${JSON.stringify(task)}`);
  }
  await client.queue.subscribeToStatus(task.endpoint, {
    requestId: task.requestId, mode: 'polling', pollInterval: 2000, timeout: 30 * 60_000, logs: false,
  });
  return (await client.queue.result(task.endpoint, { requestId: task.requestId })).data;
}
