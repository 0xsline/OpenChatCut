import catalogData from '../../assets/agent/openchatcut-tool-schemas.json';
import { assertValidAgentToolSchemas, validateAgentToolInvocation } from '../../src/agent/execution-policy';
import type { AgentToolSchema } from '../../src/agent/tool-schema';

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsedSchema(value: unknown): AgentToolSchema {
  if (!objectRecord(value)
    || typeof value.name !== 'string'
    || !objectRecord(value.input_schema)
    || value.input_schema.type !== 'object') {
    throw new Error('Invalid generated server tool schema.');
  }
  const description = typeof value.description === 'string'
    ? value.description
    : undefined;
  const properties = value.input_schema.properties;
  const required = value.input_schema.required;
  if (properties !== undefined && !objectRecord(properties)) {
    throw new Error(`Invalid properties for generated tool ${value.name}.`);
  }
  if (required !== undefined
    && (!Array.isArray(required)
      || required.some((item) => typeof item !== 'string'))) {
    throw new Error(`Invalid required fields for generated tool ${value.name}.`);
  }
  return {
    name: value.name,
    ...(description ? { description } : {}),
    input_schema: {
      ...value.input_schema,
      type: 'object',
      ...(properties ? { properties } : {}),
      ...(required ? { required } : {}),
    },
  };
}

function generatedCatalog(key: 'edit' | 'ask'): readonly AgentToolSchema[] {
  if (!objectRecord(catalogData)
    || catalogData.version !== 1
    || !Array.isArray(catalogData[key])) {
    throw new Error('Invalid generated server tool catalog.');
  }
  const schemas = catalogData[key].map(parsedSchema);
  assertValidAgentToolSchemas(schemas);
  return Object.freeze(schemas);
}

const EDIT_TOOL_SCHEMAS = generatedCatalog('edit');
const ASK_TOOL_SCHEMAS = generatedCatalog('ask');

function canonicalJson(value: unknown): string {
  if (!objectRecord(value)) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    return JSON.stringify(value);
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function sameSchema(
  left: Record<string, unknown>,
  right: AgentToolSchema,
): boolean {
  return left.name === right.name
    && (left.description ?? '') === (right.description ?? '')
    && canonicalJson(left.input_schema) === canonicalJson(right.input_schema);
}
export function canonicalServerRunToolCatalog(
  askOnly: boolean,
): readonly AgentToolSchema[] {
  const canonical = askOnly ? ASK_TOOL_SCHEMAS : EDIT_TOOL_SCHEMAS;
  return canonical;
}

/** Resolve a browser-supplied tool list to immutable canonical request-scoped schemas. */
export function resolveServerRunToolCatalog(
  requested: readonly unknown[],
  askOnly: boolean,
): readonly AgentToolSchema[] {
  const canonical = canonicalServerRunToolCatalog(askOnly);
  const byName = new Map(canonical.map((schema) => [schema.name, schema]));
  const selected: AgentToolSchema[] = [];
  const names = new Set<string>();
  for (const value of requested) {
    if (!objectRecord(value)) {
      throw new Error('Invalid server run tool schema.');
    }
    const name = typeof value.name === 'string' ? value.name : '';
    const schema = byName.get(name);
    if (!schema || !sameSchema(value, schema)) {
      throw new Error(`Non-canonical or inactive server run tool schema: ${name || '[unknown]'}.`);
    }
    if (names.has(name)) throw new Error(`Duplicate server run tool schema: ${name}.`);
    names.add(name);
    selected.push(schema);
  }
  return selected;
}

export function assertCanonicalToolInvocation(
  schema: AgentToolSchema,
  args: Record<string, unknown>,
  active: readonly AgentToolSchema[],
): void {
  const expected = active.find((candidate) => candidate.name === schema.name);
  if (!expected) throw new Error(`Tool is not active for this request: ${schema.name}`);
  if (canonicalJson(schema.input_schema) !== canonicalJson(expected.input_schema)) {
    throw new Error('Tool schema changed during request.');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`Invalid arguments for tool ${schema.name}.`);
  }
  const validation = validateAgentToolInvocation(schema, args, active);
  if (!validation.ok) throw new Error(validation.error);
}
