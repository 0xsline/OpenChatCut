import type { IncomingMessage, ServerResponse } from 'node:http';
import { TLSSocket } from 'node:tls';
import type { Plugin } from 'vite';
import {
  editorCallBinding,
  touchEditor,
  editorRegistrationMatches,
  nextEditorCall,
  nextEditorCancellation,
  registerEditor,
  settleEditorCall,
  unregisterEditor,
} from '../external-agent/broker.ts';
import { handleMcpRequest, mcpTools } from '../external-agent/mcp.ts';
import { claimBrowserProjectOwnership } from '../external-agent/project-edit-ownership.ts';
import {
  EDITOR_BOOTSTRAP_HEADER,
  configuredEditorOrigin,
  editorHttpBootstrapPayload,
  editorCredentialAuthorized,
  externalMcpAuthorized,
  headerValue,
  trustedEditorRequest,
} from '../editor-auth.ts';
import {
  readBridgeJson,
  routeExternalAgentBridge,
  sendBridgeJson,
  type BridgeOperations,
} from './external-agent-bridge-routes.ts';

export type { BridgeOperations } from './external-agent-bridge-routes.ts';


const bridgeOperations: BridgeOperations = {
  claimBrowserOwnership: claimBrowserProjectOwnership,
  editorRegistrationMatches,
  registerEditor,
  unregisterEditor,
  nextEditorCall,
  nextEditorCancellation,
  settleEditorCall,
  editorCallBinding,
  touchEditor,
  mcpTools,
};







function requestBaseUrl(req: IncomingMessage): string {
  const configured = configuredEditorOrigin();
  if (configured) return configured;
  const protocol = req.socket instanceof TLSSocket ? 'https:' : 'http:';
  return `${protocol}//${headerValue(req, 'host') ?? '127.0.0.1:5199'}`;
}

function isJsonRequest(req: IncomingMessage): boolean {
  const contentType = headerValue(req, 'content-type');
  return contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

export async function handleEditorBootstrap(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!trustedEditorRequest(req, true)) {
    sendBridgeJson(res, 403, { error: 'untrusted editor origin' });
    return;
  }
  if (!isJsonRequest(req) || headerValue(req, EDITOR_BOOTSTRAP_HEADER) !== '1') {
    sendBridgeJson(res, 415, { error: 'editor bootstrap requires JSON and bootstrap header' });
    return;
  }
  await readBridgeJson(req);
  res.setHeader('Cache-Control', 'no-store');
  sendBridgeJson(res, 200, editorHttpBootstrapPayload());
}

export async function handleExternalAgentBridge(
  req: IncomingMessage,
  res: ServerResponse,
  operations: BridgeOperations = bridgeOperations,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const write = req.method === 'POST';
  if (!trustedEditorRequest(req, write)) {
    sendBridgeJson(res, 403, { error: 'untrusted editor origin' });
    return;
  }
  if (!editorCredentialAuthorized(req, write)) {
    sendBridgeJson(res, 401, { error: 'invalid editor bridge credential' });
    return;
  }
  if (write && !isJsonRequest(req)) {
    sendBridgeJson(res, 415, { error: 'editor bridge writes require JSON' });
    return;
  }
  await routeExternalAgentBridge(req, res, url, operations);
}

export function externalAgentPlugin(options: { editorBootstrapHttp?: boolean } = {}): Plugin {
  return {
    name: 'openchatcut-external-agent',
    configureServer(server) {
      if (options.editorBootstrapHttp !== false) {
        server.middlewares.use('/api/external-agent/bootstrap', (req, res) => {
          if (req.method !== 'POST') {
            sendBridgeJson(res, 405, { error: 'method not allowed' });
            return;
          }
          void handleEditorBootstrap(req, res).catch((error) => {
            if (!res.headersSent) sendBridgeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
          });
        });
      }
      server.middlewares.use('/api/external-agent', (req, res) => {
        void handleExternalAgentBridge(req, res).catch((error) => {
          if (!res.headersSent) sendBridgeJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        });
      });
      server.middlewares.use('/api/external-mcp/mcp', (req, res) => {
        if (!externalMcpAuthorized(req)) {
          sendBridgeJson(res, 401, { error: 'invalid OpenChatCut MCP token' });
          return;
        }
        void handleMcpRequest(req, res, requestBaseUrl(req)).catch((error) => {
          server.config.logger.error(`[external-mcp] ${error instanceof Error ? error.message : String(error)}`);
          if (!res.headersSent) sendBridgeJson(res, 500, { error: 'MCP request failed' });
        });
      });
    },
  };
}
