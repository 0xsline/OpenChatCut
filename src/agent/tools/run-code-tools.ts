// run_code — lets a loaded skill execute its shipped scripts (ffmpeg / node / python /
// bash) in our own e2b cloud sandbox, via the server-side /e2b/run proxy (which holds the
// key). Write optional input files, run one command, read optional outputs. The sandbox
// is isolated from the editor — results come back here and the agent applies them with the
// editor tools. This is the portable execution substrate that stands in for the native
// Agent Skills container our relay can't reach.
import type { AgentToolSchema } from '../tool-schema';

export const RUN_CODE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'run_code',
    description:
      'Run a shell command in an isolated Linux sandbox (e2b) — use for skill-shipped scripts, ffmpeg/ffprobe media probing/transcoding, or node/python. Optionally write input files first (files[]) and read output files back (outputs[]). The sandbox cannot touch the editor timeline; apply any result with the editor tools. Call this when a loaded skill instructs you to run a script or command.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run, e.g. "ffmpeg -version" or "node process-media.mjs in.mp4".' },
        files: {
          type: 'array',
          description: 'Input files to write into the sandbox before running. Each item gives a target path plus either inline content OR a url to fetch: a local media-pool/asset url like "/media/uploads/x.mp4" (served from the app) or a public "https://…" url. Use this to bring real media in for ffprobe/ffmpeg. (A public URL can also be probed directly by passing it to ffprobe without files.)',
          items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, url: { type: 'string' } }, required: ['path'] },
        },
        outputs: { type: 'array', description: 'Paths of files to read back after running.', items: { type: 'string' } },
      },
      required: ['command'],
    },
  },
];

export const RUN_CODE_TOOL_NAMES = new Set(RUN_CODE_TOOL_SCHEMAS.map((t) => t.name));

export async function execRunCodeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'run_code') return { error: `unknown tool ${name}` };
  try {
    const res = await fetch('/e2b/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) return { error: (data.error as string) ?? `e2b failed (${res.status})` };
    return data;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
