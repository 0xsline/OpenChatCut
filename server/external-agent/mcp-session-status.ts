export interface McpSessionStatusInput {
  connectedProjectIds: string[];
  editors: unknown[];
  binding: unknown;
  bindingMode: 'browser' | 'offline' | null;
  toolCount: number;
  exposure: Record<string, unknown>;
}

export function mcpSessionStatus(input: McpSessionStatusInput): Record<string, unknown> {
  const serverDirect = input.bindingMode === 'offline'
    || (!input.bindingMode && !input.connectedProjectIds.length);
  return {
    connectedProjectIds: input.connectedProjectIds,
    editors: input.editors,
    sessionBinding: input.binding,
    bindingMode: input.bindingMode,
    availableToolTier: serverDirect ? 'server-direct' : 'browser',
    offlineFallback: 'Target an existing stored project with no browser owner, then begin with approvalMode="auto".',
    browserRequiredFor: [
      'visual/canvas inspection',
      'generation',
      'upload',
      'network',
      'preset',
      'render',
      'export',
      'manual approval',
    ],
    toolCount: input.toolCount,
    ...input.exposure,
  };
}
