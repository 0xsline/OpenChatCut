import { redactTextForAgentRuntime } from './runtime-artifact';

export type ApprovalDetailKind =
  | 'action'
  | 'command'
  | 'url'
  | 'path'
  | 'output'
  | 'target'
  | 'parameter';

export interface ApprovalDetail {
  readonly kind: ApprovalDetailKind;
  readonly label: string;
  readonly value: string;
}

export interface ToolApprovalPresentation {
  readonly summary: string;
  readonly details: readonly ApprovalDetail[];
}

function safeText(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  return redactTextForAgentRuntime(raw ?? String(value));
}

function add(
  details: ApprovalDetail[],
  kind: ApprovalDetailKind,
  label: string,
  value: unknown,
): void {
  if (value === undefined || value === null || value === '') return;
  details.push({ kind, label, value: safeText(value) });
}

function runCodeDetails(args: Readonly<Record<string, unknown>>): ApprovalDetail[] {
  const details: ApprovalDetail[] = [];
  add(details, 'command', '命令', args.command);
  if (Array.isArray(args.files)) {
    for (const file of args.files) {
      if (!file || typeof file !== 'object' || Array.isArray(file)) continue;
      const input = file as Record<string, unknown>;
      add(details, 'path', '输入路径', input.path);
      add(details, 'url', '输入网址', input.url);
    }
  }
  if (Array.isArray(args.outputs)) {
    for (const output of args.outputs) {
      add(details, 'output', '输出目标', output);
    }
  }
  return details;
}

function designDetails(args: Readonly<Record<string, unknown>>): ApprovalDetail[] {
  const details: ApprovalDetail[] = [];
  add(details, 'action', '操作', args.action);
  add(details, 'target', '样式 ID', args.presetId);
  add(details, 'target', '样式名称', args.name ?? args.rename);
  return details;
}

const FIELD_DETAILS: ReadonlyArray<readonly [string, ApprovalDetailKind, string]> = [
  ['action', 'action', '操作'],
  ['command', 'command', '命令'],
  ['url', 'url', '网址'],
  ['urls', 'url', '网址'],
  ['sourceUrl', 'url', '源网址'],
  ['filePath', 'path', '文件路径'],
  ['inputPath', 'path', '输入路径'],
  ['targetPath', 'path', '目标路径'],
  ['destinationPath', 'output', '输出目标'],
  ['path', 'path', '路径'],
  ['outputPath', 'output', '输出目标'],
  ['outputs', 'output', '输出目标'],
  ['destination', 'output', '输出目标'],
  ['output', 'output', '输出目标'],
  ['filename', 'output', '输出名称'],
  ['outputTarget', 'output', '输出目标'],
  ['name', 'output', '输出名称'],
  ['repo', 'target', '仓库'],
  ['slug', 'target', '安装目录'],
  ['provider', 'parameter', '服务商'],
  ['skill', 'target', '技能'],
  ['assetId', 'target', '资源 ID'],
  ['projectId', 'target', '工程 ID'],
  ['skillId', 'target', '技能 ID'],
  ['templateId', 'target', '模板 ID'],
  ['versionId', 'target', '版本 ID'],
  ['model', 'parameter', '模型'],
  ['prompt', 'parameter', '请求内容'],
  ['format', 'parameter', '格式'],
  ['codec', 'parameter', '编码'],
  ['resolution', 'parameter', '分辨率'],
];

function genericDetails(args: Readonly<Record<string, unknown>>): ApprovalDetail[] {
  const details: ApprovalDetail[] = [];
  for (const [key, kind, label] of FIELD_DETAILS) add(details, kind, label, args[key]);
  return details;
}

export function approvalPresentationFromDetails(
  tool: string,
  details: readonly ApprovalDetail[],
): ToolApprovalPresentation {
  const suffix = details.map((detail) => `${detail.label}=${detail.value}`).join(' · ');
  return { summary: suffix ? `${tool} · ${suffix}` : tool, details };
}

export function formatToolApprovalDetails(
  tool: string,
  args: Readonly<Record<string, unknown>>,
): ToolApprovalPresentation {
  const details = tool === 'run_code'
    ? runCodeDetails(args)
    : tool === 'manage_design_style'
      ? designDetails(args)
      : genericDetails(args);
  if (tool === 'download_media') add(details, 'output', '输出目录', '/media/uploads/');
  return approvalPresentationFromDetails(tool, details);
}
