import type { AgentToolSchema } from '../../tool-schema';

const MAX_WAIT_SECONDS = 3600;

/** Server-executed export tool for headless external agents.
 *
 * The browser catalog already has submit_render_job/track_export, which run in
 * the editor tab. An external agent connected over MCP may have no tab, so this
 * tool drives the same server export pipeline in-process and returns the
 * finished file's absolute path. Only the offline (server-direct) MCP catalog
 * exposes it; see server/external-agent/offline-tools.ts. */
export const EXPORT_VIDEO_TOOL_NAME = 'export_video';

export const EXPORT_VIDEO_TOOL_SCHEMA: AgentToolSchema = {
  name: EXPORT_VIDEO_TOOL_NAME,
  description: [
    'Render the current timeline of this edit session to a video file in the app media folder and return its absolute path, so you can inspect the result with your own tools.',
    'Uses the server export pipeline (no browser editor needed), so this works in a headless MCP session.',
    'Blocks until the render finishes or timeoutSeconds elapses; on timeout, call again with the returned renderId to resume polling without starting a second render.',
    'MP4/H.264 by default. Optional frame boundaries use a half-open [startFrame, endFrameExclusive) range.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Output filename. Defaults to the timeline name.' },
      format: { type: 'string', enum: ['video', 'audio'], description: 'Defaults to video.' },
      codec: { type: 'string', enum: ['h264', 'vp8', 'mp3', 'wav'], description: 'Video: h264 (default) or vp8. Audio: mp3 (default) or wav.' },
      resolution: { type: 'string', enum: ['480p', '720p', '1080p'], description: 'Video only. Scale by the short side; omit to use the timeline size.' },
      fps: { type: 'integer', description: 'Video only. Target frame rate, one of 24/25/30/50/60; omit to use the timeline fps.' },
      videoBitrate: { type: 'integer', minimum: 1_000_000, maximum: 80_000_000, description: 'Video only. Exact output bitrate in bits per second; omit for the renderer default.' },
      startFrame: { type: 'integer', minimum: 0 },
      endFrameExclusive: { type: 'integer', minimum: 1 },
      startSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer startFrame.' },
      endSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer endFrameExclusive.' },
      renderId: { type: 'string', description: 'Resume waiting for an export job returned by an earlier call instead of starting a new render.' },
      timeoutSeconds: {
        type: 'number',
        minimum: 0,
        maximum: MAX_WAIT_SECONDS,
        description: 'Maximum seconds to wait for the render (default 120). 0 waits until the render is terminal. Use a bounded wait so a background job can be reported instead of ending with no status.',
      },
    },
    additionalProperties: false,
  },
};
