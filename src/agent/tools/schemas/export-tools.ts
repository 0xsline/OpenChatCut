import type { AgentToolSchema } from '../../tool-schema';

const MAX_WAIT_SECONDS = 3600;

export const EXPORT_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'submit_render_job',
    description:
      'Render the active timeline ASYNCHRONOUSLY as MP4/WebM video or MP3/WAV audio. Returns immediately with a renderId instead of blocking; the render runs in a background job. Poll track_export for status/progress and the download URL. Prefer this over the synchronous submit_export for long timelines. Optional frame boundaries use a half-open [startFrame, endFrameExclusive) range.',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['video', 'audio'], description: 'Defaults to video.' },
        codec: { type: 'string', enum: ['h264', 'vp8', 'mp3', 'wav'], description: 'Video: h264 (default) or vp8. Audio: mp3 (default) or wav.' },
        resolution: { type: 'string', enum: ['480p', '720p', '1080p'], description: 'Video only. Scale by the short side; omit to use the timeline size.' },
        fps: { type: 'integer', description: 'Video only. Target frame rate, one of 24/25/30/50/60; omit to use the timeline fps.' },
        name: { type: 'string', description: 'Download filename.' },
        startFrame: { type: 'integer', minimum: 0 },
        endFrameExclusive: { type: 'integer', minimum: 1 },
        startSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer startFrame.' },
        endSeconds: { type: 'number', minimum: 0, description: 'Legacy; prefer endFrameExclusive.' },
      },
    },
  },
  {
    name: 'track_export',
    description:
      'Inspect render/export jobs started by submit_render_job. action=status: return current status. action=wait: poll until the selected jobs are terminal or timeoutSeconds elapses. Pass renderIds when available. If renderIds is omitted, latest defaults to true and returns the most recent matching render job. Set latest=false to list recent render jobs so you can tell which exports are complete, still rendering, or failed. onlyActive=true narrows the latest lookup to currently rendering jobs. Returns status, progress, and — when completed — a downloadUrl the browser can fetch.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'wait'], description: 'status or wait' },
        renderIds: { type: 'string', description: 'Comma-separated render job IDs or prefixes returned by submit_render_job.' },
        latest: { type: 'boolean', description: 'When true, read the newest matching render job. Defaults to true when renderIds is omitted.' },
        onlyActive: { type: 'boolean', description: 'When latest=true, return only currently rendering jobs. Use false/omit to include recently completed or failed renders.' },
        timelineId: { type: 'string', description: 'Optional timeline ID or prefix to narrow latest lookup.' },
        timeoutSeconds: { type: 'number', minimum: 0, maximum: MAX_WAIT_SECONDS, description: 'For action=wait, maximum seconds before returning the current non-terminal status. Defaults to 90. Use 0 for unbounded wait.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'read_export_history',
    description:
      'List recent finished exports (most recent first): filename, format, codec, size, frame range, and time. Use to remind the user what they have already exported this session and earlier. Read-only; does not export anything.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max records to return; defaults to 20.' },
      },
    },
  },
];

export const EXPORT_TOOL_NAMES = new Set(EXPORT_TOOL_SCHEMAS.map((t) => t.name));
