import assert from 'node:assert/strict';
import type { PropSpec } from '../../types';
import { groupInspectorPropSchema } from './inspectorPropSchemaLayout';

const schema: PropSpec[] = [
  { key: 'title', label: 'Title', type: 'text', defaultValue: '' },
  { key: 'cardColor', label: 'Card', type: 'color', defaultValue: '#101827' },
  { key: 'textColor', label: 'Text', type: 'color', defaultValue: '#ffffff' },
  { key: 'accentColor', label: 'Accent', type: 'color', defaultValue: '#9d7ff2' },
  { key: 'padding', label: 'Padding', type: 'number', defaultValue: 24 },
];

assert.deepEqual(
  groupInspectorPropSchema(schema).map((group) => ({
    kind: group.kind,
    keys: group.fields.map((field) => field.key),
  })),
  [
    { kind: 'field', keys: ['title'] },
    { kind: 'color-row', keys: ['cardColor', 'textColor', 'accentColor'] },
    { kind: 'field', keys: ['padding'] },
  ],
);

console.log('inspectorPropSchemaLayout.verify: adjacent colors share a row');
