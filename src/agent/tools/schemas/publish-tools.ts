import type { AgentToolSchema } from '../../tool-schema';

const PLATFORMS = ['tiktok', 'instagram', 'youtube', 'linkedin', 'facebook', 'x', 'threads', 'pinterest', 'bluesky'];

export const PUBLISH_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'publish_to_social',
    description:
      'Publish a finished video render to social platforms (TikTok, Instagram Reels, YouTube, LinkedIn, Facebook, X, Threads, Pinterest, Bluesky) through Upload-Post. '
      + 'Two steps, always: (1) call WITHOUT confirm — nothing is uploaded; it returns needsConfirm, a requestId, and the file, profile, platforms, '
      + 'missingPlatforms (not connected on the profile, would be skipped), title and privacy. Show that preview to the user. (2) Only after the user '
      + 'explicitly approves it in this conversation, call again with the SAME arguments plus confirm:true and previewId set to that requestId. '
      + 'If the Upload-Post account, the profile, the file or any field changed since the preview, the confirm is refused with preview_mismatch: preview again and ask again. '
      + 'Pinterest needs pinterestBoardId. '
      + 'A confirm returns phase admitted immediately and the upload continues in the background; poll track_social_publish with the requestId. '
      + 'Publishing is public and cannot be undone; re-sending an approved publish resumes it instead of posting twice. '
      + 'source is the downloadUrl from a completed track_export (/media/uploads/...). Requires the Upload-Post key and profile in Settings.',
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
        pinterestBoardId: {
          type: 'string',
          description: 'Required when platforms includes pinterest: the ID of the Pinterest board to pin the video to. Ask the user for it.',
        },
        aiGenerated: {
          type: 'boolean',
          description: 'Disclose AI-generated content (TikTok, Instagram, YouTube and X labels). Ask the user when the video uses generated visuals or voice.',
        },
        confirm: {
          type: 'boolean',
          description: 'Omit on the first call (preview). true only after the user approved the preview in chat.',
        },
        previewId: {
          type: 'string',
          description: 'Required with confirm:true: the requestId returned by the preview the user approved.',
        },
      },
      required: ['source', 'platforms', 'title'],
    },
  },
  {
    name: 'track_social_publish',
    description:
      'Check a publish started by publish_to_social. action=status returns the current state; action=wait polls until it settles or timeoutSeconds '
      + 'elapses, then returns the last known state with waitExpired (use one bounded wait, then report). status is uploading while the video is '
      + 'still being sent, then per-platform results: completed (url or postId), failed (error), retryable, or skipped (no account on the profile). '
      + 'status unknown means Upload-Post never confirmed the upload: it is not re-sent. Read-only.',
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
