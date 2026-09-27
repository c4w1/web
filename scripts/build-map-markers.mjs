/**
 * Generate data/geo/markers.geojson from the catalog (SQLite export).
 *
 * One Point marker per dataset that has a `location` in the backend: local
 * datasets at their place, national datasets at their publishing agency's
 * headquarters. Datasets without a location are left off the map; they
 * still appear in the catalog.
 *
 * Usage: node scripts/build-map-markers.mjs   (runs in `npm run prebuild`)
 */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalogSources } from './sync-catalog-from-backend.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../data/geo/markers.geojson');

const slug = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function topicalTags(source) {
  const tags = source.description_tags;
  const names = Array.isArray(tags)
    ? tags
    : Object.entries(tags ?? {})
        .filter(([, active]) => active)
        .map(([name]) => name);
  return names.map(slug).filter(Boolean).slice(0, 6);
}

export function buildMarkers(sources) {
  const features = sources
    .filter((s) => s?.id && s.location && Number.isFinite(Number(s.location.latitude)))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => {
      const url = s.provider?.url ?? s.download?.url;
      const properties = {
        id: slug(s.id),
        name: s.title,
        category: 'dataset',
        tags: topicalTags(s),
        region: 'US',
        ...(s.description ? { description: s.description } : {}),
        ...(s.location.label ? { locationLabel: s.location.label } : {}),
        ...(url && /^https?:\/\//.test(url) ? { sourceUrl: url } : {}),
      };
      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [Number(s.location.longitude), Number(s.location.latitude)],
        },
        properties,
      };
    });
  return { type: 'FeatureCollection', features };
}

async function main() {
  const { sources, origin } = await loadCatalogSources();
  const collection = buildMarkers(sources);
  await writeFile(outPath, JSON.stringify(collection, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${collection.features.length} map marker(s) from ${origin}`);
  console.log(`  → ${outPath}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
