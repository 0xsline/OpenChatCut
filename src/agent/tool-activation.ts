import type { ModelMessage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { AgentToolSchema } from './tool-schema';
import { isExternalGlobalReadTool, isExternalReadTool } from './external-tool-policy';
import { routedToolSelection } from './tool-routing';

const BOOT_TOOL_NAMES: Record<string, true> = {
  ToolSearch: true,
  load_skill: true,
  read_project: true,
  read_timeline: true,
  ask_followup_questions: true,
  report_user_friction: true,
  read_agent_artifact: true,
};

const READ_ONLY_TERMS = ['不要修改', '不要编辑', '只读', 'read only', 'read-only', 'do not edit', "don't edit", 'without editing'];
const CAPABILITY_TERMS = ['tool', 'tools', 'capability', 'capabilities', 'ability', 'abilities', '工具', '能力'];
const DISCOVERY_TERMS = ['what', 'which', 'available', 'list', 'find', 'show', 'discover', '哪些', '什么', '可用', '列出', '查看', '看看', '查一下', '找一下'];

function isReadOnlyRequest(request: string): boolean {
  return READ_ONLY_TERMS.some((term) => request.includes(term));
}
function isDomainToolDiscoveryRequest(request: string): boolean {
  return CAPABILITY_TERMS.some((term) => request.includes(term))
    && DISCOVERY_TERMS.some((term) => request.includes(term));
}
function isReadOnlyTool(name: string): boolean {
  return BOOT_TOOL_NAMES[name] === true
    || isExternalGlobalReadTool(name)
    || isExternalReadTool(name);
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
function bootNames(
  messages: readonly ModelMessage[],
  routed: readonly string[],
  routingOverflow: boolean,
): string[] {
  const retainSearch = routingOverflow || routed.length === 0
    || isDomainToolDiscoveryRequest(latestUserText(messages));
  return Object.keys(BOOT_TOOL_NAMES).filter((name) => (
    name !== 'ToolSearch' || retainSearch
  ));
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
  const routed = routedToolSelection(request, isReadOnlyRequest(request));
  return {
    names: catalog.filter((schema) => routed.names.has(schema.name)).map((schema) => schema.name),
    overflow: routed.overflow,
  };
}

export class ToolActivation {
  private readonly activeNames: ReadonlySet<string>;
  private readonly byName: ReadonlyMap<string, AgentToolSchema>;
  private readonly catalog: readonly AgentToolSchema[];
  private readonly readOnly: boolean;

  constructor(
    catalog: readonly AgentToolSchema[],
    messages: readonly ModelMessage[],
    activeNames: Iterable<string> = [],
    allowSearch = true,
    readOnly = isReadOnlyRequest(latestUserText(messages)),
  ) {
    this.catalog = catalog;
    this.byName = new Map(catalog.map((schema) => [schema.name, schema]));
    const routed = routedNames(catalog, messages);
    const searchAllowed = allowSearch && !toolSearchConsumed(messages);
    this.readOnly = readOnly;
    const requested = [
      ...bootNames(messages, routed.names, routed.overflow),
      ...activatedToolNamesFromMessages(messages),
      ...routed.names,
      ...activeNames,
    ].filter((name) => (
      (searchAllowed || name !== 'ToolSearch')
      && (!this.readOnly || isReadOnlyTool(name))
    ));
    this.activeNames = new Set(requested.filter((name) => this.byName.has(name)));
  }

  withSearchResult(result: unknown): {
    readonly activation: ToolActivation;
    readonly result: unknown;
  } {
    if (!result || typeof result !== 'object'
      || !('results' in result) || !Array.isArray(result.results)) {
      return { activation: this, result };
    }
    const discovered = new Set(result.results.flatMap((row) => {
      if (!row || typeof row !== 'object' || !('name' in row)) return [];
      return typeof row.name === 'string' ? [row.name] : [];
    }));
    const activatedTools = this.catalog
      .filter((schema) => (
        discovered.has(schema.name)
        && (!this.readOnly || isReadOnlyTool(schema.name))
      ))
      .map((schema) => schema.name);
    return {
      activation: new ToolActivation(
        this.catalog,
        [],
        [...this.activeNames, ...activatedTools],
        activatedTools.length === 0,
        this.readOnly,
      ),
      result: { ...result, activatedTools },
    };
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
