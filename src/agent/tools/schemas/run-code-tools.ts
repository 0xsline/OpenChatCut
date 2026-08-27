import type { AgentToolSchema } from '../../tool-schema';

export const RUN_CODE_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'run_code',
    description:
      'Run a shell command in an isolated Linux sandbox (e2b) — use for skill-shipped scripts, ffmpeg/ffprobe media probing/transcoding, or node/python. Optionally write input files first (files[]) and read output files back (outputs[]). The sandbox cannot touch the editor timeline; apply any result with the editor tools. Call this when a loaded skill instructs you to run a script or command. '
      + 'Do not use for flex crop, keep-only-region jobs, or measuring clip edges (use edit_item transform.crop). The user does not need to forbid this tool in the prompt. If sandbox is not in configured capabilities, do not call this tool.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Shell command to run, e.g. "ffmpeg -version" or "node process-media.mjs in.mp4".' },
        files: {
          type: 'array',
          description: 'Input files to write into the sandbox before running. Each item gives a target path plus either inline content OR a url to fetch: a local media-pool/asset url like "/media/uploads/x.mp4" (served from the app) or a public "https://…" url. Use this to bring real media in for ffprobe/ffmpeg. (A public URL can also be probed directly by passing it to ffprobe without files.)',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              content: { type: 'string' },
              url: { type: 'string' },
            },
            required: ['path'],
          },
        },
        outputs: { type: 'array', description: 'Paths of files to read back after running.', items: { type: 'string' } },
      },
      required: ['command'],
    },
  },
];

export const RUN_CODE_TOOL_NAMES = new Set(RUN_CODE_TOOL_SCHEMAS.map((t) => t.name));
