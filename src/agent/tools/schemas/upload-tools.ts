import type { AgentToolSchema } from '../../tool-schema';

const ASSET_TYPES = ['audio', 'gif', 'image', 'svg', 'video'] as const;

export const UPLOAD_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'import_media',
    description: [
      'Create a formal external import session with one short-lived, single-use upload slot.',
      'The slot is bound to session, project, asset, filename, POST method, MIME type, and exact byte size.',
      'Upload the declared bytes, then pass the opaque server receipt and echoed assetType to finalize_uploaded_asset.',
      'No media-pool asset is published before finalize succeeds.',
      'Provide assetId only to replace an existing pool asset; omit it for a new asset.',
      'Prefer download_media for public URLs.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create_session'],
          description: 'Must be create_session.',
        },
        assetId: {
          type: 'string',
          description: 'Optional existing media-pool asset id or unique prefix to replace.',
        },
        assetType: {
          type: 'string',
          enum: [...ASSET_TYPES],
          description: 'audio|gif|image|svg|video.',
        },
        filename: { type: 'string', description: 'Safe original filename used to scope the upload.' },
        contentType: { type: 'string', description: 'MIME type, e.g. video/mp4.' },
        size: { type: 'integer', minimum: 1, description: 'Required exact byte size of the upload.' },
        projectId: { type: 'string', description: 'Ignored; the active project is used.' },
      },
      required: ['action', 'assetType', 'filename', 'contentType', 'size'],
    },
  },
  {
    name: 'finalize_uploaded_asset',
    description: [
      'Finalize bytes uploaded through an external upload handoff.',
      'Pass the opaque receipt plus assetType from the successful upload response; path, hash, size, filename, and authoritative media type are resolved server-side.',
      'The receipt is claimed during validation and normalization, then consumed only after the asset commit succeeds.',
      'durationInSeconds is schema-required for audio/video/gif; width/height may supply media metadata.',
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        receipt: { type: 'string', description: 'Opaque one-time receipt from the successful upload response.' },
        assetType: {
          type: 'string',
          enum: [...ASSET_TYPES],
          description: 'Media type echoed by the upload response; it must match the trusted receipt.',
        },
        durationInSeconds: { type: 'number', exclusiveMinimum: 0, description: 'Duration for audio, gif, or video.' },
        width: { type: 'number', exclusiveMinimum: 0 },
        height: { type: 'number', exclusiveMinimum: 0 },
        fps: { type: 'number', exclusiveMinimum: 0, description: 'Optional video fps metadata (stored only if useful).' },
        hasAudioTrack: { type: 'boolean' },
        projectId: { type: 'string' },
      },
      required: ['receipt', 'assetType'],
      allOf: [{
        if: {
          properties: { assetType: { enum: ['audio', 'gif', 'video'] } },
          required: ['assetType'],
        },
        then: { required: ['durationInSeconds'] },
      }],
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
