import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  connectedProjectIds,
  editorStatuses,
  invokeEditorTool,
  registeredTools,
  resolveProjectId,
  setTargetProject,
} from './broker.ts';
import { createExternalProject, listExternalProjects } from './projects.ts';

const PROJECT_SELECTOR = {
  type: 'string',
  description: 'OpenChatCut project id. Optional when exactly one editor is connected or target_project was called.',
};

const CONTROL_TOOLS: Tool[] = [
  {
    name: 'openchatcut_status',
    description: 'Show connected OpenChatCut editors and the current MCP capability status.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_projects',
    description: 'List OpenChatCut projects, newest first.',
    inputSchema: {
      type: 'object',
      properties: {
        includeDeleted: { type: 'boolean' },
        editorBaseUrl: { type: 'string' },
      },
    },
  },
  {
    name: 'create_project',
    description: 'Create an empty OpenChatCut project with one active timeline and one video track.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        compositionWidth: { type: 'number' },
        compositionHeight: { type: 'number' },
        fps: { type: 'number' },
        editorBaseUrl: { type: 'string' },
      },
    },
  },
  {
    name: 'target_project',
    description: 'Select the OpenChatCut project used by later calls that omit editorProjectId.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, editorBaseUrl: { type: 'string' } },
      required: ['projectId'],
    },
  },
  {
    name: 'get_editor_url',
    description: 'Return the OpenChatCut editor URL for a project.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string' }, editorBaseUrl: { type: 'string' } },
    },
  },
];

function editorUrl(args: Record<string, unknown>, projectId: string, fallbackBase: string): string {
  const base = String(args.editorBaseUrl ?? '').trim() || fallbackBase;
  return `${base.replace(/\/+$/, '')}/#/editor/${encodeURIComponent(projectId)}`;
}

export function mcpTools(): Tool[] {
  const controls = new Set(CONTROL_TOOLS.map((tool) => tool.name));
  const editorTools = registeredTools()
    .filter((tool) => !controls.has(tool.name))
    .map((tool): Tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        ...tool.input_schema,
        properties: {
          ...tool.input_schema.properties,
          editorProjectId: PROJECT_SELECTOR,
        },
      },
    }));
  return [...CONTROL_TOOLS, ...editorTools];
}

async function callControlTool(
  name: string,
  args: Record<string, unknown>,
  baseUrl: string,
): Promise<unknown | undefined> {
  if (name === 'openchatcut_status') {
    return { connectedProjectIds: connectedProjectIds(), editors: editorStatuses(), toolCount: mcpTools().length };
  }
  if (name === 'list_projects') {
    const projects = await listExternalProjects(args.includeDeleted === true);
    return projects.map((project) => ({
      ...project,
      editorUrl: editorUrl(args, project.id, baseUrl),
    }));
  }
  if (name === 'create_project') {
    const project = await createExternalProject(args);
    setTargetProject(project.id);
    return { ...project, editorUrl: editorUrl(args, project.id, baseUrl) };
  }
  if (name === 'target_project') {
    const projectId = String(args.projectId ?? '').trim();
    if (!projectId) throw new Error('projectId is required');
    setTargetProject(projectId);
    return { ok: true, projectId, editorUrl: editorUrl(args, projectId, baseUrl) };
  }
  if (name === 'get_editor_url') {
    const projectId = resolveProjectId(args.projectId);
    return { projectId, editorUrl: editorUrl(args, projectId, baseUrl) };
  }
  return undefined;
}

async function callTool(name: string, rawArgs: unknown, baseUrl: string): Promise<unknown> {
  const args = rawArgs && typeof rawArgs === 'object'
    ? { ...(rawArgs as Record<string, unknown>) }
    : {};
  const control = await callControlTool(name, args, baseUrl);
  if (control !== undefined) return control;
  const projectId = resolveProjectId(args.editorProjectId);
  delete args.editorProjectId;
  if ((name === 'track_progress' || name === 'track_export') && args.action === 'wait') {
    const requested = Number(args.timeoutSeconds);
    args.timeoutSeconds = Math.min(45, requested > 0 ? requested : 45);
  }
  return invokeEditorTool(projectId, name, args);
}

function makeServer(baseUrl: string): Server {
  const server = new Server(
    { name: 'openchatcut', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await callTool(request.params.name, request.params.arguments, baseUrl);
      return {
        content: toMcpContent(result),
        structuredContent: toStructuredContent(result),
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: error instanceof Error ? error.message : String(error),
        }],
      };
    }
  });
  return server;
}

interface EmbeddedImage {
  base64: string;
  frame?: number;
  mimeType?: string;
}

function embeddedImages(result: unknown): EmbeddedImage[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
  const images = (result as { __images?: unknown }).__images;
  if (!Array.isArray(images)) return [];
  return images.filter((image): image is EmbeddedImage => (
    Boolean(image)
    && typeof image === 'object'
    && typeof (image as EmbeddedImage).base64 === 'string'
  ));
}

export function toStructuredContent(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return { result };
  const record = result as Record<string, unknown>;
  const images = embeddedImages(record);
  if (!images.length) return record;
  const { __images: _images, ...rest } = record;
  return {
    ...rest,
    images: images.map((image) => ({
      frame: image.frame,
      mimeType: image.mimeType ?? 'image/jpeg',
    })),
  };
}

export function toMcpContent(result: unknown): CallToolResult['content'] {
  const structured = toStructuredContent(result);
  return [
    { type: 'text', text: JSON.stringify(structured) },
    ...embeddedImages(result).map((image) => ({
      type: 'image' as const,
      data: image.base64,
      mimeType: image.mimeType ?? 'image/jpeg',
    })),
  ];
}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
): Promise<void> {
  const server = makeServer(baseUrl);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
