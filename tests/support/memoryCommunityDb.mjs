/**
 * In-memory stand-in for netlify/lib/communityDb.mjs with the same methods and
 * the same database rules (unique slug and county, last-editor guard, one request
 * per person per library), for
 * testing the librarian API without Postgres.
 */

import { ConflictError } from '../../netlify/lib/communityDb.mjs';

export function createMemoryCommunityDb(seed = [], requestSeed = []) {
  /** slug -> { community, editors: string[] } */
  const rows = new Map(seed.map(({ editors = [], ...community }) => [community.slug, { community: { ...community }, editors: [...editors] }]));
  const out = ({ community, editors }) => ({ ...community, editors: [...editors] });
  /** Open co-librarian requests: { slug, email, message, requested_at } */
  const requests = requestSeed.map((r, i) => ({ message: null, requested_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), ...r }));
  const findRequest = (slug, email) => requests.findIndex((r) => r.slug === slug && r.email === email);

  return {
    rows,
    requests,
    async listAll() {
      return [...rows.values()].map(({ community }) => ({ ...community }));
    },
    async listAllWithEditors() {
      return [...rows.values()].map(out);
    },
    async get(slug) {
      const row = rows.get(slug);
      return row ? out(row) : null;
    },
    async listForEditor(email) {
      return [...rows.values()].filter((row) => row.editors.includes(email)).map(out);
    },
    async listPending() {
      return [...rows.values()].filter((row) => !row.community.approved).map(out);
    },
    async create(community, email) {
      if (rows.has(community.slug) || [...rows.values()].some((r) => r.community.county_fips === community.county_fips)) {
        throw new ConflictError('duplicate');
      }
      rows.set(community.slug, { community: { ...community, approved: false, created_by: email }, editors: [email] });
    },
    async update(slug, community) {
      const row = rows.get(slug);
      row.community = { ...community, slug, approved: row.community.approved, created_by: row.community.created_by };
      return { ...row.community };
    },
    async addEditor(slug, email) {
      const row = rows.get(slug);
      if (!row || row.editors.includes(email)) throw new ConflictError('duplicate editor');
      const i = findRequest(slug, email);
      if (i !== -1) requests.splice(i, 1);
      row.editors.push(email);
    },
    async removeEditor(slug, email) {
      const row = rows.get(slug);
      if (!row || row.editors.length <= 1 || !row.editors.includes(email)) throw new ConflictError('cannot remove');
      row.editors = row.editors.filter((e) => e !== email);
    },
    async listRequests(slug) {
      return requests.filter((r) => r.slug === slug).map(({ email, message, requested_at }) => ({ email, message, requested_at }));
    },
    async listAllRequests() {
      return requests
        .filter((r) => rows.has(r.slug))
        .map((r) => ({ slug: r.slug, name: rows.get(r.slug).community.name, email: r.email, message: r.message, requested_at: r.requested_at }));
    },
    async listRequestsBy(email) {
      return requests
        .filter((r) => r.email === email && rows.has(r.slug))
        .map((r) => ({ slug: r.slug, name: rows.get(r.slug).community.name, requested_at: r.requested_at }));
    },
    async addRequest(slug, email, message) {
      if (!rows.has(slug) || findRequest(slug, email) !== -1) throw new ConflictError('duplicate request');
      requests.push({ slug, email, message, requested_at: new Date().toISOString() });
    },
    async deleteRequest(slug, email) {
      const i = findRequest(slug, email);
      if (i === -1) throw new ConflictError('no request');
      requests.splice(i, 1);
    },
    async acceptRequest(slug, email) {
      const i = findRequest(slug, email);
      const row = rows.get(slug);
      if (i === -1 || !row || row.editors.includes(email)) throw new ConflictError('cannot accept');
      requests.splice(i, 1);
      row.editors.push(email);
    },
    async approve(slug) {
      const row = rows.get(slug);
      if (!row || row.community.approved) throw new ConflictError('not pending');
      row.community.approved = true;
      return { ...row.community };
    },
    async reject(slug) {
      const row = rows.get(slug);
      if (!row || row.community.approved) throw new ConflictError('not pending');
      rows.delete(slug);
      for (let i = requests.length - 1; i >= 0; i--) if (requests[i].slug === slug) requests.splice(i, 1);
    },
  };
}
