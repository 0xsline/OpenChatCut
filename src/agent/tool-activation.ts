import type { ModelMessage } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import type { AgentToolSchema } from './tool-schema';
import { isExternalGlobalReadTool, isExternalReadTool } from './external-tool-policy';

const BOOT_TOOL_NAMES: Record<string, true> = {
  ToolSearch: true,
  load_skill: true,
  read_project: true,
  read_timeline: true,
  ask_followup_questions: true,
  report_user_friction: true,
};

interface RoutingGroup {
  readonly requestKeywords?: readonly string[];
  readonly requestContext?: readonly (readonly string[])[];
  readonly mutating?: boolean;
  readonly toolKeywords: readonly string[];
}

const ROUTING_GROUPS: readonly RoutingGroup[] = [
  {
    mutating: true,
    requestKeywords: ['edit', 'trim', 'split', 'move', 'delete', 'remove', 'add', 'insert', 'create', 'update', 'modify', 'adjust', 'apply', 'reorder', 'background fill', 'blur', '剪辑', '裁剪', '分割', '移动', '删除', '移除', '添加', '新增', '插入', '创建', '修改', '调整', '设置', '应用', '排列', '排序', '重排', '填充', '模糊', '虚化'],
    toolKeywords: ['edit_item', '_item', 'edit_track', 'manage_timelines', 'undo_', 'redo_', 'apply_layout'],
  },
  {
    requestContext: [
      ['elevenlabs', 'doubao', 'minimax', 'inworld', 'fish audio', 'fishaudio', 'speechify', 'openai', 'gemini', 'mistral', 'cartesia'],
      ['tts', 'text-to-speech', 'speech synthesis', 'voice generation', 'voiceover generation', '配音', '语音合成'],
    ],
    toolKeywords: ['submit_voice'],
  },
  {
    requestContext: [
      ['assemblyai', 'local', 'openai', 'mistral', 'deepgram', 'groq', 'elevenlabs', 'cartesia'],
      ['transcribe', 'transcription', 'speech-to-text', 'stt', 'asr', '转写', '语音识别'],
    ],
    toolKeywords: ['transcribe_track'],
  },
  {
    requestKeywords: ['transcript', 'caption', 'subtitle', 'script', 'speech', 'silence', 'voice', 'loudness', '文字稿', '字幕', '台词', '口播', '静音', '人声', '响度'],
    toolKeywords: ['transcript', 'caption', 'script', 'silence', 'voice', 'loudness', 'text'],
  },
  {
    requestKeywords: ['audio', 'music', 'sound', 'voice', 'loudness', 'bgm', '音频', '声音', '音乐', '音效', '人声', '响度', '配音', '背景音乐'],
    toolKeywords: ['audio', 'music', 'sound', 'voice', 'loudness', 'transcribe'],
  },
  {
    requestKeywords: ['library', 'template', 'effect', 'transition', 'zoom', 'lut', 'graphic', 'watermark', '素材库', '模板', '特效', '转场', '动效', '水印'],
    toolKeywords: ['library', 'template', 'effect', 'transition', 'motion_graphic', 'watermark', 'graphic', 'font'],
  },
  {
    requestKeywords: ['generate', 'image', 'video', 'music', 'sound', 'voiceover', 'shader', '生成', '图片', '视频', '音乐', '音效', '配音', '着色器'],
    toolKeywords: ['submit_', 'generate', 'shader', 'motion_graphic', 'progress'],
  },
  {
    requestKeywords: ['import', 'upload', 'download', 'media', 'asset', 'stock', '素材', '导入', '上传', '下载', '媒体', '版权'],
    toolKeywords: ['media', 'asset', 'upload', 'download', 'stock', 'probe', 'push_'],
  },
  {
    requestKeywords: ['export', 'render', 'xml', 'prores', 'premiere', 'resolve', '导出', '渲染', '成片'],
    toolKeywords: ['export', 'render', 'download'],
  },
  {
    requestKeywords: ['project', 'sequence', 'version', 'marker', 'design style', '项目', '序列', '版本', '标记', '设计风格'],
    toolKeywords: ['project', 'timeline', 'version', 'marker', 'design_style'],
  },
  {
    requestKeywords: ['scene', 'highlight', 'beat', 'downbeat', 'rhythm', 'multicam', 'reframe', 'color', '镜头', '高光', '节拍', '卡点', '重拍', '节奏', '多机位', '重构图', '调色', '分析'],
    toolKeywords: ['scene', 'highlight', 'beat', 'music', 'multicam', 'reframe', 'color', 'grade', 'frame'],
  },
  {
    requestKeywords: ['web', 'search', 'crawl', 'website', 'skill', 'code', '网页', '搜索', '抓取', '网站', '技能', '脚本'],
    toolKeywords: ['web_', 'skill', 'run_code', 'search_'],
  },
];
// Composite requests can span edit, audio, generation, and import without needing the full catalog.
const MAX_ROUTING_GROUPS = 4;
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
function bootNames(messages: readonly ModelMessage[], routed: readonly string[]): string[] {
  const domainDiscovery = routed.length > 0
    && isDomainToolDiscoveryRequest(latestUserText(messages));
  return Object.keys(BOOT_TOOL_NAMES).filter((name) => (
    name !== 'ToolSearch' || !domainDiscovery
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


function routedNames(catalog: readonly AgentToolSchema[], messages: readonly ModelMessage[]): string[] {
  const request = latestUserText(messages);
  if (!request) return [];
  const readOnly = isReadOnlyRequest(request);
  const matchingGroups = ROUTING_GROUPS.filter((group) => {
    const directMatch = group.requestKeywords?.some((keyword) => request.includes(keyword)) ?? false;
    const contextualMatch = group.requestContext?.every((alternatives) => (
      alternatives.some((keyword) => request.includes(keyword))
    )) ?? false;
    return (!group.mutating || !readOnly) && (directMatch || contextualMatch);
  }).slice(0, MAX_ROUTING_GROUPS);
  return catalog
    .filter((schema) => matchingGroups.some((group) => (
      group.toolKeywords.some((keyword) => schema.name.includes(keyword))
    )))
    .map((schema) => schema.name);
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
    const readOnly = isReadOnlyRequest(latestUserText(messages));
    const requested = [
      ...bootNames(messages, routed),
      ...activatedToolNamesFromMessages(messages),
      ...routed,
      ...activeNames,
    ].filter((name) => (
      (searchAllowed || name !== 'ToolSearch')
      && (!readOnly || isReadOnlyTool(name))
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
      .filter((schema) => discovered.has(schema.name))
      .map((schema) => schema.name);
    return {
      activation: new ToolActivation(
        this.catalog,
        [],
        [...this.activeNames, ...activatedTools],
        activatedTools.length === 0,
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
