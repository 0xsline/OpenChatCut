import type { ModelMessage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { AgentToolSchema } from './tool-schema';
import { hasMutationRoutingIntent, routedToolSelection } from './tool-routing';
import { activatedToolNamesForResult } from './skills/skill-tool-activation';

const BOOT_TOOL_NAMES: Record<string, true> = {
  ToolSearch: true,
  load_skill: true,
  read_project: true,
  read_timeline: true,
  ask_followup_questions: true,
  report_user_friction: true,
  read_agent_artifact: true,
};

const READ_ONLY_TERMS = [
  '不要修改', '不要编辑', '只读',
  'read only', 'read-only', 'do not edit', "don't edit", 'without editing',
];

/** A natural-language hint may narrow initial routing, but never becomes tool authority. */
function isReadOnlyRoutingHint(request: string): boolean {
  let remainder = request.toLowerCase();
  let matched = false;
  for (const term of READ_ONLY_TERMS) {
    if (!remainder.includes(term)) continue;
    matched = true;
    remainder = remainder.split(term).join('');
  }
  return matched && !hasMutationRoutingIntent(remainder);
}


function textFromMessage(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.flatMap((part) => {
    if (!part || typeof part !== 'object' || !('text' in part)) return [];
    return typeof part.text === 'string' ? [part.text] : [];
  }).join(' ');
}

function latestUserText(messages: readonly ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return textFromMessage(messages[index]).toLowerCase();
  }
  return '';
}
function bootNames(): string[] {
  return Object.keys(BOOT_TOOL_NAMES);
}

function collectActivatedNames(value: unknown, names: string[]): void {
  if (typeof value === 'string') {
    try { collectActivatedNames(JSON.parse(value), names); } catch { /* not JSON */ }
    return;
  }
  if (!value || typeof value !== 'object') return;
  if ('activatedTools' in value && Array.isArray(value.activatedTools)) {
    for (const name of value.activatedTools) if (typeof name === 'string') names.push(name);
  }
  if ('value' in value && value.value !== undefined) collectActivatedNames(value.value, names);
}
export function activatedToolNamesFromResult(value: unknown): string[] {
  const names: string[] = [];
  collectActivatedNames(value, names);
  return [...new Set(names)];
}

function isActivationCheckpoint(message: ModelMessage): boolean {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false;
  return message.content.some((part) => {
    if (!part || typeof part !== 'object' || !('providerOptions' in part)) return false;
    const options = part.providerOptions;
    if (!options || typeof options !== 'object' || !('openchatcut' in options)) return false;
    const names: string[] = [];
    collectActivatedNames(options.openchatcut, names);
    return names.length > 0;
  });
}

function activationScanStart(messages: readonly ModelMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== 'assistant' || isActivationCheckpoint(message)) continue;
    if (typeof message.content === 'string' && message.content.trim()) return index + 1;
    if (Array.isArray(message.content) && message.content.some((part) => (
      part && typeof part === 'object' && 'type' in part && part.type === 'text'
        && 'text' in part && typeof part.text === 'string' && part.text.trim()
    ))) return index + 1;
  }
  return 0;
}

export function activationProviderOptions(names: readonly string[]): ProviderOptions | undefined {
  const activatedTools = [...new Set(names)];
  return activatedTools.length ? { openchatcut: { activatedTools } } : undefined;
}

export function activatedToolNamesFromMessages(messages: readonly ModelMessage[]): string[] {
  const names: string[] = [];
  for (const message of messages.slice(activationScanStart(messages))) {
    if (message.role === 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (!part || typeof part !== 'object') continue;
      if ('providerOptions' in part) {
        const options = part.providerOptions;
        if (options && typeof options === 'object' && 'openchatcut' in options) {
          collectActivatedNames(options.openchatcut, names);
        }
      }
      if (!('type' in part) || part.type !== 'tool-result') continue;
      if (!('toolName' in part) || part.toolName !== 'ToolSearch' || !('output' in part)) continue;
      names.push(...activatedToolNamesFromResult(part.output));
    }
  }
  return [...new Set(names)];
}
function toolSearchConsumed(messages: readonly ModelMessage[]): boolean {
  for (const message of messages.slice(activationScanStart(messages))) {
    if (isActivationCheckpoint(message)) {
      return !activatedToolNamesFromMessages([message]).includes('ToolSearch');
    }
    if (message.role !== 'tool' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result'
        || part.toolName !== 'ToolSearch'
        || !('output' in part)) continue;
      if (activatedToolNamesFromResult(part.output).length > 0) return true;
    }
  }
  return false;
}


function routedNames(
  catalog: readonly AgentToolSchema[],
  messages: readonly ModelMessage[],
): { readonly names: string[]; readonly overflow: boolean } {
  const request = latestUserText(messages);
  if (!request) return { names: [], overflow: false };
  const routed = routedToolSelection(request, isReadOnlyRoutingHint(request));
  return {
    names: catalog.filter((schema) => routed.names.has(schema.name)).map((schema) => schema.name),
    overflow: routed.overflow,
  };
}

export class ToolActivation {
  private readonly activeNames: ReadonlySet<string>;
  private readonly byName: ReadonlyMap<string, AgentToolSchema>;
  private readonly catalog: readonly AgentToolSchema[];

  constructor(
    catalog: readonly AgentToolSchema[],
    messages: readonly ModelMessage[],
    activeNames: Iterable<string> = [],
    allowSearch = true,
  ) {
    this.catalog = catalog;
    this.byName = new Map(catalog.map((schema) => [schema.name, schema]));
    const routed = routedNames(catalog, messages);
    const searchAllowed = allowSearch && !toolSearchConsumed(messages);
    const requested = [
      ...bootNames(),
      ...activatedToolNamesFromMessages(messages),
      ...routed.names,
      ...activeNames,
    ].filter((name) => searchAllowed || name !== 'ToolSearch');
    this.activeNames = new Set(requested.filter((name) => this.byName.has(name)));
  }

  withToolResult(toolName: string, result: unknown): {
    readonly activation: ToolActivation;
    readonly result: unknown;
  } {
    const activatedTools = activatedToolNamesForResult(toolName, result, this.catalog);
    const retainSearch = toolName === 'ToolSearch'
      ? activatedTools.length === 0
      : this.activeNames.has('ToolSearch');
    return {
      activation: new ToolActivation(
        this.catalog,
        [],
        [...this.activeNames, ...activatedTools],
        retainSearch,
      ),
      result: result && typeof result === 'object' && !Array.isArray(result)
        ? { ...result, activatedTools }
        : result,
    };
  }

  withSearchResult(result: unknown): {
    readonly activation: ToolActivation;
    readonly result: unknown;
  } {
    return this.withToolResult('ToolSearch', result);
  }

  schemas(): readonly AgentToolSchema[] {
    return this.catalog.filter((schema) => this.activeNames.has(schema.name));
  }

  allSchemas(): readonly AgentToolSchema[] {
    return this.catalog;
  }

  names(): readonly string[] {
    return this.schemas().map((schema) => schema.name);
  }
}
