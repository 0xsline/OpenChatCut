import type { Plugin } from 'vite';
import { registerUploadRoutes } from './upload-routes.ts';

export { maxUploadBytes } from './upload-routes.ts';

/** Local upload, R2 hydration/presign, media serving, and remote import routes. */
export function uploadPlugin(): Plugin {
  return {
    name: 'openchatcut-upload',
    configureServer(server) {
      registerUploadRoutes(server);
    },
  };
}
