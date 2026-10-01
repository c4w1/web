/**
 * Netlify Function serving the Data Preview API in production.
 *
 * The site is built as static files, so Netlify never runs backend/server.mjs.
 * This function exposes the same /api/* routes using the shared handler and the
 * Node preview engine, with sources from the SQLite export. Local development
 * still uses backend/server.mjs (which can use pandas).
 */

import { createApiHandler, nodeEngine } from '../../backend/lib/apiHandler.mjs';
import { exportInfo, loadAllSources, loadSourceById } from '../../backend/lib/exportStore.mjs';

const handle = createApiHandler({
  loadAllSources,
  loadSourceById,
  engine: nodeEngine,
  health: () => ({ runtime: 'netlify-function', ...exportInfo }),
});

export default async (request) => handle(request);

export const config = {
  path: ['/api/health', '/api/sources', '/api/sources/*'],
};
