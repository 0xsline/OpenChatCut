import type { PropSpec } from '../../types';

export interface InspectorPropSchemaGroup {
  kind: 'field' | 'color-row';
  fields: PropSpec[];
}

export function groupInspectorPropSchema(schema: readonly PropSpec[]): InspectorPropSchemaGroup[] {
  const groups: InspectorPropSchemaGroup[] = [];

  for (const field of schema) {
    const previous = groups.at(-1);
    if (field.type === 'color' && previous?.kind === 'color-row') {
      previous.fields.push(field);
      continue;
    }
    groups.push({
      kind: field.type === 'color' ? 'color-row' : 'field',
      fields: [field],
    });
  }

  return groups;
}
