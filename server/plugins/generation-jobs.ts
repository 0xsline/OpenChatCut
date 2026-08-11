import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { TERMINAL } from './generation-job-types.ts';
import type { GenerationJob } from './generation-job-types.ts';
import { jobs } from './generation-job-store.ts';
import {
  initializeGenerationJobs,
  resumeGenerationJobDownload,
  resumeRestoredJobs,
} from './generation-job-lifecycle.ts';

export {
  IncompleteGenerationResultError,
  generationResultCheckpoint,
  mergeGenerationResultUrls,
  requireGenerationResultUrls,
  setGenerationResultUrlAt,
} from './generation-job-types.ts';
export type {
  GenerationAcceptance,
  GenerationCleanupPolicy,
  GenerationCleanupPolicyHandler,
  GenerationJobOptions,
  GenerationJobProgress,
  GenerationJobResumer,
  GenerationJobSnapshot,
  GenerationJobStatus,
  GenerationJobSubmission,
  GenerationJobTask,
  GenerationOperationTimestamps,
  GenerationResult,
  GenerationResultCheckpoint,
  GenerationRetentionGuard,
  GenerationRetryClass,
  RegisterGenerationDownload,
  RegisterGenerationProviderTask,
  UpdateGenerationJob,
} from './generation-job-types.ts';
export {
  registerGenerationCleanupPolicy,
  registerGenerationJobResumer,
  registerGenerationRetentionGuard,
} from './generation-job-store.ts';
export {
  createGenerationJob,
  deleteGenerationJob,
  getGenerationJobSnapshot,
  initializeGenerationJobs,
  resumeGenerationJobDownload,
  waitForGenerationAcceptance,
} from './generation-job-lifecycle.ts';

interface ProgressRequest {
  action?: 'params' | 'status' | 'wait' | 'resume';
  target?: string;
  jobIds?: string[] | string;
  timeoutSeconds?: number;
}

async function readJson(req: IncomingMessage): Promise<ProgressRequest> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > 100_000) throw new Error('request body too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProgressRequest;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseJobIds(value: ProgressRequest['jobIds']): string[] {
  const ids = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function report(job: GenerationJob, action: ProgressRequest['action']) {
  return {
    jobId: job.id,
    operationId: job.id,
    status: job.status,
    progress: job.progress,
    phase: job.phase,
    processedFrames: job.processedFrames,
    totalFrames: job.totalFrames,
    label: job.label,
    toolName: job.toolName,
    submitArgsVersion: job.submitArgs ? 1 : undefined,
    submitArgs: job.submitArgs,
    provider: job.provider,
    providerTaskId: job.providerTaskId,
    sourceRevisions: job.sourceRevisions,
    resultUrls: job.resultUrls,
    expectedResultCount: job.expectedResultCount,
    retryClass: job.retryClass,
    timestamps: job.timestamps,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(action === 'params' ? { params: job.params } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.results && job.results.length > 1 ? { results: job.results } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.code ? { code: job.code } : {}),
    ...(job.retryable !== undefined ? { retryable: job.retryable } : {}),
    ...(job.pendingDownloadUrl ? { pendingDownloadUrl: job.pendingDownloadUrl } : {}),
  };
}

const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

export function generationProgressPlugin(): Plugin {
  return {
    name: 'openchatcut-generation-progress',
    configureServer(server) {
      void initializeGenerationJobs().catch((error) => {
        server.config.logger.error(`[generate:progress] failed to restore operations: ${error instanceof Error ? error.message : String(error)}`);
      });
      server.middlewares.use('/generate/progress', async (req, res) => {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'method not allowed — use POST' }); return; }
        try {
          await initializeGenerationJobs();
          await resumeRestoredJobs();
          const input = await readJson(req);
          if (input.target !== 'generation') throw new Error('target must be generation');
          if (!input.action || !['params', 'status', 'wait', 'resume'].includes(input.action)) throw new Error('action must be params, status, wait, or resume');
          const jobIds = parseJobIds(input.jobIds);
          if (!jobIds.length) throw new Error('jobIds is required');
          const timeoutSeconds = input.timeoutSeconds ?? 90;
          if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 3600) throw new Error('timeoutSeconds must be between 0 and 3600');

          if (input.action === 'wait') {
            const deadline = Date.now() + timeoutSeconds * 1000;
            while (Date.now() < deadline) {
              const known = jobIds.map((id) => jobs.get(id));
              if (known.every((job) => !job || TERMINAL.has(job.status))) break;
              await wait(250);
            }
          }
          if (input.action === 'resume') await Promise.all(jobIds.map((id) => resumeGenerationJobDownload(id)));

          const reports = jobIds.map((id) => {
            const job = jobs.get(id);
            return job ? report(job, input.action) : { jobId: id, operationId: id, status: 'not_found', error: 'generation job not found' };
          });
          sendJson(res, 200, { target: 'generation', action: input.action, reports });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[generate:progress] ${message}`);
          sendJson(res, 400, { error: message });
        }
      });
    },
  };
}
