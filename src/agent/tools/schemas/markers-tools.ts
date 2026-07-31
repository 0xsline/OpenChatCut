import type { AgentToolSchema } from '../../tool-schema';

const COLORS = ['blue', 'cyan', 'fuchsia', 'green', 'pink', 'purple', 'red', 'yellow'];

export const MARKERS_TOOL_SCHEMAS: AgentToolSchema[] = [
  {
    name: 'manage_markers',
    description: [
      'Manage timeline annotation/TODO anchors using the marker-note-v2 contract. A marker is a point when durationFrames=0 or omitted, otherwise a range.',
      'scope=project anchors to a ruler frame; scope=item anchors to a clip.',
      'action: list all | create one or a markers[] batch | update one or an updates[] batch | delete.',
      'For transcript-backed notes, pass transcriptSegments using Active Script [sN] segment ids plus optional notePrefix instead of writing note manually.',
      'fromFrame defaults to the start of the first selected segment unless provided explicitly, and the note body is copied from read_script output.',
      `color must be one of ${COLORS.join('/')}.`,
    ].join(' '),
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        timelineId: { type: 'string', description: 'Target timeline id or prefix; omit to use the current timeline without switching timelines.' },
        fromFrame: { type: 'number', description: 'Integer timeline frame to anchor the marker at (required for create unless transcriptSegments is used).' },
        durationFrames: { type: 'number', description: 'Range length; 0 or omitted creates a point marker. With transcriptSegments, defaults to covering the selected segments.' },
        note: { type: 'string', description: 'Marker note text (required for create unless transcriptSegments is used).' },
        color: { type: 'string', enum: COLORS },
        scope: { type: 'string', enum: ['project', 'item'], description: 'item requires itemId; default project.' },
        itemId: { type: 'string', description: 'Clip id to anchor when scope=item.' },
        markerId: { type: 'string', description: 'Target marker id for update/delete.' },
        transcriptSegments: { type: 'string', description: 'Active Script segment ids/ranges from timeline.md, e.g. "3-4"; note text is copied from read_script output.' },
        transcriptTrack: { type: 'string', description: 'Track filter for transcriptSegments, e.g. V1 or A1.' },
        notePrefix: { type: 'string', description: 'Optional label prefix when transcriptSegments derives the note body.' },
        markers: {
          type: 'array',
          description: 'create batch: each entry is {fromFrame?, note?, color?, durationFrames?, scope?, itemId?, transcriptSegments?, transcriptTrack?, notePrefix?}; omit fromFrame when transcriptSegments determines placement.',
          items: { type: 'object' },
        },
        updates: {
          type: 'array',
          description: 'update batch: each entry is {id, note?, color?, fromFrame?, durationFrames?}.',
          items: { type: 'object' },
        },
      },
      required: ['action'],
    },
  },
];

export const MARKERS_TOOL_NAMES = new Set(MARKERS_TOOL_SCHEMAS.map((t) => t.name));
