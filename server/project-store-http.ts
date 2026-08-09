import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  routeProjectStoreRequest,
  type ProjectStoreHttpOperations,
} from './project-store-http-routes.ts';

export { sendProjectStoreJson } from './project-store-http-routes.ts';

export async function handleProjectStoreRequest(
  req: IncomingMessage,
  res: ServerResponse,
  operations: ProjectStoreHttpOperations,
): Promise<void> {
  await routeProjectStoreRequest(req, res, operations);
}
