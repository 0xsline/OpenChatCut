import type { AgentToolSchema } from '../../tool-schema';

const PLATFORMS = ['tiktok', 'instagram', 'youtube', 'linkedin', 'facebook', 'x', 'threads', 'pinterest', 'bluesky'];

export const PUBLISH_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'publish_to_social',
    description:
      'Publish a finished video render to social platforms (TikTok, Instagram Reels, YouTube, LinkedIn, Facebook, X, Threads, Pinterest, Bluesky) through Upload-Post. '
      + 'Two steps, always: (1) call WITHOUT confirm — nothing is uploaded; it returns needsConfirm with the file, profile, platforms, missingPlatforms '
      + '(not connected on the profile, would be skipped), title and privacy. Show that preview to the user. (2) Only after the user explicitly approves it '
      + 'in this conversation, call again with the SAME arguments plus confirm:true. Publishing is public and cannot be undone. Re-sending the same arguments '
      + 'resumes the same post instead of posting twice. source is the downloadUrl from a completed track_export (/media/uploads/...). '
      + 'Then poll track_social_publish with the returned requestId. Requires the Upload-Post key and profile in Settings.',
    input_schema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'downloadUrl of a completed video render (/media/uploads/<file>.mp4).' },
        platforms: {
          type: 'array',
          items: { type: 'string', enum: PLATFORMS },
          minItems: 1,
          description: 'Where to publish. TikTok, Instagram Reels and YouTube Shorts expect a vertical 9:16 render.',
        },
        title: { type: 'string', description: 'Caption / title used on every platform. YouTube allows at most 100 characters.' },
        description: { type: 'string', description: 'Optional longer text for YouTube, LinkedIn, Facebook and Pinterest.' },
        youtubePrivacy: { type: 'string', enum: ['private', 'unlisted', 'public'], description: 'Defaults to private.' },
        tiktokPrivacy: {
          type: 'string',
          enum: ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'],
          description: 'Omit to keep the TikTok account default.',
        },
        aiGenerated: {
          type: 'boolean',
          description: 'Disclose AI-generated content (TikTok, Instagram, YouTube and X labels). Ask the user when the video uses generated visuals or voice.',
        },
        confirm: {
          type: 'boolean',
          description: 'Omit on the first call (preview). true only after the user approved the preview in chat.',
        },
      },
      required: ['source', 'platforms', 'title'],
    },
  },
  {
    name: 'track_social_publish',
    description:
      'Check a publish started by publish_to_social. action=status returns the current per-platform results; action=wait polls until every platform '
      + 'finishes or timeoutSeconds elapses (use one bounded wait, then report). Each result is completed (with url or postId), failed (with error), '
      + 'retryable, or skipped (no account connected on the profile). Read-only.',
    input_schema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'requestId returned by publish_to_social.' },
        action: { type: 'string', enum: ['status', 'wait'], description: 'Defaults to status.' },
        timeoutSeconds: { type: 'number', minimum: 0, maximum: 25, description: 'For action=wait. Defaults to 20.' },
      },
      required: ['requestId'],
    },
  },
];

export const PUBLISH_TOOL_NAMES = new Set(PUBLISH_TOOL_SCHEMAS.map((tool) => tool.name));
