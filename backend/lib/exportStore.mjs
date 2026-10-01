/**
 * Source store backed by the backend's SQLite export (backend/data/exports/catalog.json).
 *
 * Used by the Netlify Function, where neither the SQLite file nor node:sqlite is
 * available. The JSON is imported (not read from disk) so the function bundler
 * includes it automatically.
 */

import catalog from '../data/exports/catalog.json' with { type: 'json' };

/** Flatten nested analysis tag sets into the source shape the preview code expects. */
function toSource({ analysis_tags: analysisTags = {}, ...rest }) {
  return { ...analysisTags, ...rest };
}

const sources = catalog.sources.map(toSource);
const byId = new Map(sources.map((source) => [source.id, source]));

export const exportInfo = { dataSource: 'sqlite-export', sourceCount: sources.length };

export async function loadAllSources() {
  return sources;
}

export async function loadSourceById(id) {
  return byId.get(id) ?? null;
}
