import type { AgentToolSchema } from '../../tool-schema';

export const TIMELINE_IMPORT_TOOL_SCHEMAS: AgentToolSchema[] = [{
  name: 'import_timeline',
  description: [
    'Import a Final Cut Pro / DaVinci Resolve FCPXML 1.x project or a CMX 3600 EDL into a new editable OpenChatCut timeline.',
    'The new timeline runs at the project frame rate; a sequence or list at another rate is converted, rounding cut points to the nearest frame.',
    'FCPXML times are converted to the new timeline through the sequence tcStart and every enclosing clip, gap, connected clip or storyline (lanes), compound clip (ref-clip), sync-clip, multicam clip (active angle) and audition (active pick), including rate conform and retime speed; source in-points are measured from each file\'s own start timecode.',
    'EDL events are placed from the list\'s record start: the hour boundary (e.g. 01:00:00:00) when the first record-in is within a minute of it, otherwise the first record-in, or startTimecode when given. EDLs do not record their frame rate: fps defaults to the current timeline\'s (29.97/59.94 for drop-frame lists).',
    'Referenced files must already exist in the current media pool; matching uses asset id, original path, source path, source filename, and asset name. Unresolved or ambiguous media aborts the import without changing the project.',
    'Titles, generators, captions, transitions, effects, disabled clips, and audio of a video file that its video clip cannot carry are not imported; the result lists every skipped element with its reason and warns about approximations.',
  ].join(' '),
  input_schema: {
    type: 'object',
    properties: {
      format: { type: 'string', enum: ['fcpxml', 'edl'], description: 'Interchange format.' },
      content: { type: 'string', description: 'Complete UTF-8 FCPXML or CMX 3600 EDL document text.' },
      name: { type: 'string', description: 'Optional imported timeline name.' },
      activate: { type: 'boolean', description: 'Open the imported timeline after success; default true.' },
      fps: {
        type: 'number',
        exclusiveMinimum: 0,
        maximum: 240,
        description: 'EDL only: frame rate the list was written at, e.g. 25 or 29.97. Default: the current timeline fps.',
      },
      startTimecode: {
        type: 'string',
        pattern: '^\\d{1,2}[:;]\\d{2}[:;]\\d{2}[:;.,]\\d{2}$',
        description: 'EDL only: record timecode that becomes frame 0, e.g. "01:00:00:00" or "00:59:50:00".',
      },
    },
    required: ['format', 'content'],
    additionalProperties: false,
  },
}];

export const TIMELINE_IMPORT_TOOL_NAMES = new Set(TIMELINE_IMPORT_TOOL_SCHEMAS.map((tool) => tool.name));
