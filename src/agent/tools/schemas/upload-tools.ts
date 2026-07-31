import type { AgentToolSchema } from '../../tool-schema';

const ASSET_TYPES = ['audio', 'gif', 'image', 'svg', 'video'] as const;

export const UPLOAD_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'import_media',
    description: [
      'Local media import helpers.',
      'action=create_session: short session token + directUpload URL shape.',
      'action=register_placeholder: register a media-pool row with a deterministic /media/uploads path',
      'BEFORE bytes land so you can edit_item / organize immediately.',
      'Then POST/PUT bytes to the returned uploadUrl, then finalize_uploaded_asset (normalize + ASR).',
      'Prefer download_media for public URLs.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_session', 'register_placeholder'],
          description: 'create_session | register_placeholder (early pool row before upload).',
        },
        projectId: { type: 'string', description: 'Ignored; the active project is used.' },
        // register_placeholder fields
        assetType: {
          type: 'string',
          enum: [...ASSET_TYPES],
          description: 'register_placeholder: audio|gif|image|svg|video.',
        },
        filename: { type: 'string', description: 'register_placeholder: original filename.' },
        contentType: { type: 'string', description: 'register_placeholder: MIME type, e.g. video/mp4.' },
        durationInSeconds: { type: 'number', description: 'register_placeholder: required for audio/video/gif.' },
        width: { type: 'number' },
        height: { type: 'number' },
        hasAudioTrack: { type: 'boolean', description: 'register_placeholder: if false, skip later ASR.' },
        size: { type: 'number', description: 'register_placeholder: optional known byte size.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'request_asset_upload_url',
    description: [
      'Get a one-time local upload target to push media bytes into the project.',
      'LOCAL-DEV: returns POST/PUT /upload?name=&assetId= (not real S3). Then upload bytes with Content-Type matching contentType,',
      'then call finalize_uploaded_asset with the returned assetId/fileKey/readUrl/size/type.',
      'Prefer download_media/push_asset for public URLs; use this when you already have local file bytes.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        assetType: {
          type: 'string',
          enum: [...ASSET_TYPES],
          description: 'File-backed asset type: audio, gif, image, svg, or video.',
        },
        contentType: {
          type: 'string',
          description: 'MIME type of the file you will upload, e.g. video/mp4. Header MUST match.',
        },
        filename: { type: 'string', description: 'Original filename, e.g. clip.mp4.' },
        size: { type: 'number', description: 'Byte size if known.' },
        projectId: { type: 'string', description: 'Ignored; the active project is used.' },
      },
      required: ['assetType', 'contentType', 'filename'],
    },
  },
  {
    name: 'finalize_uploaded_asset',
    description: [
      'Register an asset after bytes were uploaded via request_asset_upload_url.',
      'Creates a media-pool row pointing at the local /media/uploads path. Do not call before upload completes.',
      'gif/svg map to kind=image. durationInSeconds required for audio/video/gif; width/height for image/video.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'assetId from request_asset_upload_url.' },
        fileKey: { type: 'string', description: 'fileKey from request_asset_upload_url.' },
        filename: { type: 'string' },
        readUrl: { type: 'string', description: 'readUrl from request_asset_upload_url (local /media/uploads/…).' },
        size: { type: 'number', description: 'Positive byte size of the uploaded file.' },
        type: { type: 'string', enum: [...ASSET_TYPES] },
        durationInSeconds: { type: 'number', description: 'Required for audio, gif, video.' },
        width: { type: 'number' },
        height: { type: 'number' },
        fps: { type: 'number', description: 'Optional video fps metadata (stored only if useful).' },
        hasAudioTrack: { type: 'boolean' },
        projectId: { type: 'string' },
      },
      required: ['assetId', 'fileKey', 'filename', 'readUrl', 'size', 'type'],
    },
  },
  {
    name: 'request_asset_download',
    description: [
      'Return a user-facing download URL/path for a media-pool asset.',
      'Local-dev: returns the asset.src (usually /media/uploads/…). Not for motion-graphics without src.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Project asset ID or unique prefix.' },
        variant: { type: 'string', description: 'Only "source" is supported.' },
        projectId: { type: 'string' },
      },
      required: ['assetId'],
    },
  },
];

export const UPLOAD_TOOL_NAMES = new Set(UPLOAD_TOOL_SCHEMAS.map((t) => t.name));
