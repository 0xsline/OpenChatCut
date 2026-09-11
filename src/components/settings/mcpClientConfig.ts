// MCP config snippets for clients OpenChatCut cannot write to disk.
// 千问办公 keeps custom servers only in its own connector store (added by pasting
// JSON in the app), so this is the one shape its import accepts.
const QWEN_WORK_SERVER_TYPE = 'streamable-http';

export function qwenWorkMcpConfig(endpoint: string, token: string): { mcpServers: Record<string, Record<string, unknown>> } {
  return {
    mcpServers: {
      openchatcut: {
        type: QWEN_WORK_SERVER_TYPE,
        url: endpoint,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
}

export function qwenWorkConnectJson(endpoint: string, token: string): string {
  return JSON.stringify(qwenWorkMcpConfig(endpoint, token), null, 2);
}
