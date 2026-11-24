import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createVocabulary } from '../src/lib/community/geoVocabulary.mjs';
import { createLibrarianHandler, routeParts } from '../netlify/lib/librarianApi.mjs';
import { createBuildHook } from '../netlify/lib/buildHook.mjs';
import librarianFunction, { config } from '../netlify/functions/librarian-api.mjs';
import { createMemoryCommunityDb } from './support/memoryCommunityDb.mjs';

const vocabulary = createVocabulary({
  vintage: 2025,
  states: [{ geoid: '47', name: 'Tennessee', usps: 'TN' }],
  counties: [
    { geoid: '47093', name: 'Knox County', state: 'TN' },
    { geoid: '47037', name: 'Davidson County', state: 'TN' },
    { geoid: '47001', name: 'Anderson County', state: 'TN' },
  ],
});

const SITE = 'https://cdl.example';
const users: Record<string, { email: string; roles: string[] }> = {
  editor: { email: 'librarian@knoxdata.org', roles: [] },
  helper: { email: 'helper@knoxdata.org', roles: [] },
  stranger: { email: 'stranger@example.org', roles: [] },
  admin: { email: 'team@cdl.org', roles: ['admin'] },
};

type Email = { to: string[]; replyTo: string; subject: string; text: string };

function setup({ send = null }: { send?: ((email: Email) => Promise<void>) | null } = {}) {
  const db = createMemoryCommunityDb([
    { slug: 'knox-county', name: 'Knox County Data Library', place_name: 'Knoxville', county_fips: '47093', approved: true, editors: ['librarian@knoxdata.org', 'helper@knoxdata.org'] },
    { slug: 'anderson', name: 'Anderson Library', county_fips: '47001', approved: false, editors: ['new@anderson.org'] },
  ]);
  const rebuilds: string[] = [];
  const handle = createLibrarianHandler({
    verifyUser: async (request: Request) => users[request.headers.get('x-test-user') ?? ''] ?? null,
    db: () => db,
    rebuild: async (reason: string) => {
      rebuilds.push(reason);
      return 'triggered';
    },
    vocabulary,
    send,
  });
  async function call(method: string, path: string, { user, body, origin = SITE }: { user?: string; body?: unknown; origin?: string | null } = {}) {
    const headers: Record<string, string> = {};
    if (user) headers['x-test-user'] = user;
    if (origin) headers.Origin = origin;
    const response = await handle(
      new Request(`${SITE}/api/librarian/libraries${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    );
    return { status: response.status, body: await response.json() };
  }
  return { db, rebuilds, call };
}

const davidson = { name: 'Davidson County Data Library', place_name: 'Nashville', county_fips: '47037' };

test('routes', () => {
  assert.deepEqual(routeParts('/api/librarian/libraries'), []);
  assert.deepEqual(routeParts('/api/librarian/libraries/knox-county/editors/a%40b.org/'), ['knox-county', 'editors', 'a@b.org']);
  assert.equal(routeParts('/api/other'), null);
  assert.deepEqual(config.path, ['/api/librarian/libraries', '/api/librarian/libraries/*']);
});

test('every route needs a login', async () => {
  const { call } = setup();
  for (const [method, path] of [['GET', ''], ['POST', ''], ['GET', '/knox-county'], ['PUT', '/knox-county'], ['POST', '/knox-county/approve']]) {
    assert.equal((await call(method, path)).status, 401, `${method} ${path}`);
  }
});

test('writes from another origin, or without an Origin header, are refused', async () => {
  const { call, db } = setup();
  assert.equal((await call('POST', '', { user: 'stranger', body: davidson, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '', { user: 'stranger', body: davidson, origin: null })).status, 403);
  assert.equal(db.rows.has('davidson-county-data-library'), false);
});

test('GET lists the libraries the user edits, with derived state and county; admins also see pending ones', async () => {
  const { call } = setup();
  const mine = await call('GET', '', { user: 'editor' });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.isAdmin, false);
  assert.deepEqual(mine.body.libraries.map((l: { slug: string }) => l.slug), ['knox-county']);
  assert.equal(mine.body.libraries[0].state_code, 'TN');
  assert.equal(mine.body.libraries[0].county, 'Knox County');
  assert.deepEqual(mine.body.pending, []);
  const team = await call('GET', '', { user: 'admin' });
  assert.deepEqual(team.body.pending.map((l: { slug: string }) => l.slug), ['anderson']);
});

test('anyone logged in registers a pending library and becomes its editor; no rebuild yet', async () => {
  const { call, db, rebuilds } = setup();
  const res = await call('POST', '', { user: 'stranger', body: davidson });
  assert.equal(res.status, 201);
  assert.equal(res.body.library.slug, 'davidson-county-data-library');
  assert.equal(res.body.library.approved, false);
  assert.deepEqual(db.rows.get('davidson-county-data-library')!.editors, ['stranger@example.org']);
  assert.deepEqual(rebuilds, []);
  // The same county again is a conflict.
  const again = await call('POST', '', { user: 'editor', body: { ...davidson, name: 'Second Davidson' } });
  assert.equal(again.status, 409);
});

test('a county outside the vocabulary is refused', async () => {
  const { call } = setup();
  const res = await call('POST', '', { user: 'stranger', body: { ...davidson, county_fips: '47999' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.errors[0].field, 'county_fips');
});

test('editors read and edit their library; an edit to an approved library rebuilds the site', async () => {
  const { call, rebuilds } = setup();
  assert.equal((await call('GET', '/knox-county', { user: 'stranger' })).status, 403);
  const read = await call('GET', '/knox-county', { user: 'helper' });
  assert.deepEqual(read.body.library.editors, ['librarian@knoxdata.org', 'helper@knoxdata.org']);
  assert.equal(read.body.canEdit, true);

  const res = await call('PUT', '/knox-county', { user: 'helper', body: { name: 'Knox Data', description: 'New', county_fips: '47093' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.library.name, 'Knox Data');
  assert.equal(res.body.rebuild, 'triggered');
  assert.deepEqual(rebuilds, ['Update community library knox-county']);
  assert.equal((await call('PUT', '/knox-county', { user: 'stranger', body: { name: 'X', county_fips: '47093' } })).status, 403);
});

test('saving an approved library without changing a public field does not rebuild', async () => {
  const { call, rebuilds } = setup();
  const same = { name: 'Knox County Data Library', place_name: 'Knoxville', county_fips: '47093' };
  const res = await call('PUT', '/knox-county', { user: 'editor', body: same });
  assert.equal(res.status, 200);
  assert.equal(res.body.rebuild, 'not needed');
  assert.deepEqual(rebuilds, []);
});

test('editing a pending library does not rebuild', async () => {
  const { call, rebuilds } = setup();
  const anderson = { email: 'new@anderson.org', roles: [] };
  users.anderson = anderson;
  const res = await call('PUT', '/anderson', { user: 'anderson', body: { name: 'Anderson County Library', county_fips: '47001' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.rebuild, 'not needed');
  assert.deepEqual(rebuilds, []);
});

test('editors add and remove editors, but never the last one; editor changes do not rebuild', async () => {
  const { call, db, rebuilds } = setup();
  const added = await call('POST', '/knox-county/editors', { user: 'editor', body: { email: 'Teacher@School.edu' } });
  assert.equal(added.status, 201);
  assert.deepEqual(db.rows.get('knox-county')!.editors, ['librarian@knoxdata.org', 'helper@knoxdata.org', 'teacher@school.edu']);
  assert.equal((await call('POST', '/knox-county/editors', { user: 'stranger', body: { email: 'x@y.org' } })).status, 403);
  assert.equal((await call('POST', '/knox-county/editors', { user: 'editor', body: { email: 'helper@knoxdata.org' } })).status, 409);

  assert.equal((await call('DELETE', '/knox-county/editors/helper%40knoxdata.org', { user: 'editor' })).status, 200);
  assert.equal((await call('DELETE', '/knox-county/editors/teacher%40school.edu', { user: 'editor' })).status, 200);
  const last = await call('DELETE', '/knox-county/editors/librarian%40knoxdata.org', { user: 'editor' });
  assert.equal(last.status, 409);
  assert.deepEqual(db.rows.get('knox-county')!.editors, ['librarian@knoxdata.org']);
  assert.deepEqual(rebuilds, [], 'editor lists are not public');
});

// ── Co-librarian requests (web#71) ───────────────────────────

test('anyone logged in asks to become a co-librarian of a published library; editors are emailed', async () => {
  const sent: Email[] = [];
  const { call, db, rebuilds } = setup({ send: async (email) => void sent.push(email) });

  const page = await call('GET', '/knox-county/requests', { user: 'stranger' });
  assert.equal(page.status, 200);
  assert.deepEqual(page.body, { library: { slug: 'knox-county', name: 'Knox County Data Library' }, request: null });

  const asked = await call('POST', '/knox-county/requests', { user: 'stranger', body: { message: '  I teach civics at Fulton High.  ' } });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.notified, true);
  assert.deepEqual(db.requests.map(({ slug, email, message }) => ({ slug, email, message })), [
    { slug: 'knox-county', email: 'stranger@example.org', message: 'I teach civics at Fulton High.' },
  ]);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['librarian@knoxdata.org', 'helper@knoxdata.org']);
  assert.equal(sent[0].replyTo, 'stranger@example.org');
  assert.match(sent[0].text, /I teach civics at Fulton High\./);
  assert.match(sent[0].text, /https:\/\/cdl\.example\/web\/librarian\/knox-county\/edit\//);

  assert.equal((await call('POST', '/knox-county/requests', { user: 'stranger', body: {} })).status, 409, 'one request each');
  assert.equal((await call('GET', '/knox-county/requests', { user: 'stranger' })).body.request.email, 'stranger@example.org');
  assert.deepEqual((await call('GET', '', { user: 'stranger' })).body.requests.map((r: { slug: string }) => r.slug), ['knox-county']);
  assert.deepEqual(rebuilds, [], 'requests are not public');
});

test('editors, pending libraries and long notes cannot ask; a failed email still saves the request', async () => {
  const { call, db } = setup({ send: async () => Promise.reject(new Error('Resend down')) });
  assert.equal((await call('POST', '/knox-county/requests', { user: 'editor', body: {} })).status, 409);
  assert.equal((await call('POST', '/anderson/requests', { user: 'stranger', body: {} })).status, 404);
  assert.equal((await call('GET', '/anderson/requests', { user: 'stranger' })).status, 404);
  assert.equal((await call('POST', '/knox-county/requests', { user: 'stranger', body: { message: 'x'.repeat(501) } })).status, 400);
  assert.equal((await call('POST', '/knox-county/requests', { user: 'stranger', body: {}, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('POST', '/knox-county/requests')).status, 401);

  const asked = await call('POST', '/knox-county/requests', { user: 'stranger', body: {} });
  assert.equal(asked.status, 201);
  assert.equal(asked.body.notified, false);
  assert.equal(db.requests.length, 1);
});

test('editors see and accept requests; the requester becomes an editor', async () => {
  const { call, db } = setup();
  await call('POST', '/knox-county/requests', { user: 'stranger', body: { message: 'Hi' } });

  const settings = await call('GET', '/knox-county', { user: 'editor' });
  assert.deepEqual(settings.body.requests.map((r: { email: string }) => r.email), ['stranger@example.org']);
  assert.deepEqual((await call('GET', '/knox-county/requests', { user: 'helper' })).body.requests.length, 1);

  assert.equal((await call('POST', '/knox-county/requests/stranger%40example.org/accept', { user: 'stranger' })).status, 403);
  assert.equal((await call('POST', '/knox-county/requests/nobody%40example.org/accept', { user: 'editor' })).status, 404);
  const accepted = await call('POST', '/knox-county/requests/stranger%40example.org/accept', { user: 'editor' });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.requests, []);
  assert.deepEqual(db.rows.get('knox-county')!.editors, ['librarian@knoxdata.org', 'helper@knoxdata.org', 'stranger@example.org']);
  assert.equal(db.requests.length, 0);
  assert.equal((await call('GET', '/knox-county', { user: 'stranger' })).status, 200, 'the new editor can open the settings');
});

test('editors decline requests; requesters withdraw their own; nobody else can', async () => {
  const { call, db } = setup();
  await call('POST', '/knox-county/requests', { user: 'stranger', body: {} });
  await call('POST', '/knox-county/requests', { user: 'admin', body: {} });

  assert.equal((await call('DELETE', '/knox-county/requests/team%40cdl.org', { user: 'stranger' })).status, 403);
  const declined = await call('DELETE', '/knox-county/requests/team%40cdl.org', { user: 'editor' });
  assert.equal(declined.status, 200);
  assert.deepEqual(declined.body.requests.map((r: { email: string }) => r.email), ['stranger@example.org']);

  const withdrawn = await call('DELETE', '/knox-county/requests/Stranger%40example.org', { user: 'stranger' });
  assert.equal(withdrawn.status, 200);
  assert.equal(db.requests.length, 0);
  assert.equal((await call('DELETE', '/knox-county/requests/stranger%40example.org', { user: 'stranger' })).status, 404);
  assert.deepEqual(db.rows.get('knox-county')!.editors, ['librarian@knoxdata.org', 'helper@knoxdata.org']);
});

test('admins see every open request and approve or deny them with a note; the requester is emailed', async () => {
  const sent: Email[] = [];
  const { call, db } = setup({ send: async (email: Email) => void sent.push(email) });
  await call('POST', '/knox-county/requests', { user: 'stranger', body: { message: 'Hi' } });
  sent.length = 0;

  const dashboard = await call('GET', '', { user: 'admin' });
  assert.deepEqual(
    dashboard.body.allRequests.map((r: { slug: string; name: string; email: string; message: string }) => [r.slug, r.name, r.email, r.message]),
    [['knox-county', 'Knox County Data Library', 'stranger@example.org', 'Hi']]
  );
  assert.deepEqual(dashboard.body.allLibraries.map((l: { slug: string }) => l.slug).sort(), ['anderson', 'knox-county']);
  const notAdmin = await call('GET', '', { user: 'editor' });
  assert.equal(notAdmin.body.allRequests, undefined, 'only admins get every request');
  assert.equal(notAdmin.body.allLibraries, undefined);

  const settings = await call('GET', '/knox-county', { user: 'admin' });
  assert.equal(settings.status, 200);
  assert.equal(settings.body.canEdit, false);
  assert.equal(settings.body.canManageEditors, true);
  assert.equal(settings.body.requests.length, 1, 'admins see a library’s requests');

  assert.equal((await call('POST', '/knox-county/requests/stranger%40example.org/accept', { user: 'admin', body: { note: 'x'.repeat(501) } })).status, 400);
  const approved = await call('POST', '/knox-county/requests/stranger%40example.org/accept', { user: 'admin', body: { note: 'Welcome aboard' } });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.notified, true);
  assert.deepEqual(db.rows.get('knox-county')!.editors, ['librarian@knoxdata.org', 'helper@knoxdata.org', 'stranger@example.org']);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].to, ['stranger@example.org']);
  assert.match(sent[0].subject, /now a co-librarian of Knox County Data Library/);
  assert.match(sent[0].text, /Welcome aboard/);
  assert.doesNotMatch(sent[0].text, /team@cdl\.org/, 'the answer does not reveal who answered');

  db.requests.push({ slug: 'knox-county', email: 'other@example.org', message: null, requested_at: new Date().toISOString() });
  const denied = await call('DELETE', '/knox-county/requests/other%40example.org', { user: 'admin', body: { note: 'Not this time' } });
  assert.equal(denied.status, 200);
  assert.deepEqual(denied.body.requests, []);
  assert.equal(denied.body.notified, true);
  assert.match(sent[1].subject, /Your request to become a co-librarian/);
  assert.match(sent[1].text, /was declined[\s\S]*Not this time/);
  assert.deepEqual(db.rows.get('knox-county')!.editors.length, 3, 'denying adds nobody');
});

test('answers without a note, or without email set up, still work', async () => {
  const { call, db } = setup();
  await call('POST', '/knox-county/requests', { user: 'stranger', body: {} });
  const denied = await call('DELETE', '/knox-county/requests/stranger%40example.org', { user: 'admin' });
  assert.equal(denied.status, 200);
  assert.equal(denied.body.notified, false);
  assert.equal(db.requests.length, 0);
  await call('POST', '/knox-county/requests', { user: 'stranger', body: {} });
  assert.equal((await call('POST', '/knox-county/requests/stranger%40example.org/accept', { user: 'editor', body: 'not json' })).status, 400);
  assert.equal((await call('POST', '/knox-county/requests/stranger%40example.org/accept', { user: 'editor' })).status, 200);
});

test('admins grant and remove co-librarian rights directly; non-admins who are not editors cannot', async () => {
  const { call, db } = setup();
  await call('POST', '/knox-county/requests', { user: 'stranger', body: {} });

  assert.equal((await call('POST', '/knox-county/editors', { user: 'stranger', body: { email: 'friend@example.org' } })).status, 403);
  assert.equal((await call('DELETE', '/knox-county/editors/helper%40knoxdata.org', { user: 'stranger' })).status, 403);
  assert.equal((await call('GET', '/knox-county', { user: 'stranger' })).status, 403);
  assert.equal((await call('POST', '/knox-county/requests/stranger%40example.org/accept', { user: 'stranger' })).status, 403);

  const granted = await call('POST', '/knox-county/editors', { user: 'admin', body: { email: 'Stranger@Example.org' } });
  assert.equal(granted.status, 201);
  assert.deepEqual(granted.body.editors, ['librarian@knoxdata.org', 'helper@knoxdata.org', 'stranger@example.org']);
  assert.equal(db.requests.length, 0, 'a direct grant settles that person’s open request');

  const removed = await call('DELETE', '/knox-county/editors/helper%40knoxdata.org', { user: 'admin' });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.editors, ['librarian@knoxdata.org', 'stranger@example.org']);
  assert.equal((await call('POST', '/anderson/editors', { user: 'admin', body: { email: 'x@y.org' } })).status, 201, 'pending libraries too');
  assert.equal((await call('DELETE', '/anderson/editors/new%40anderson.org', { user: 'admin' })).status, 200);
  assert.equal((await call('DELETE', '/anderson/editors/x%40y.org', { user: 'admin' })).status, 409, 'never the last editor');
  assert.equal((await call('PUT', '/knox-county', { user: 'admin', body: { name: 'Renamed', county_fips: '47093' } })).status, 403, 'admins still cannot edit details');
});

test('request routes that do not exist', async () => {
  const { call } = setup();
  assert.equal((await call('PUT', '/knox-county/requests', { user: 'editor', body: {} })).status, 405);
  assert.equal((await call('POST', '/knox-county/requests/a%40b.org/other', { user: 'editor' })).status, 405);
  assert.equal((await call('POST', '/knox-county/requests/a%40b.org/accept/extra', { user: 'editor' })).status, 404);
});

test('admins approve (rebuilding the site) or reject pending libraries; nobody else can', async () => {
  const { call, db, rebuilds } = setup();
  assert.equal((await call('POST', '/anderson/approve', { user: 'editor' })).status, 403);
  const approved = await call('POST', '/anderson/approve', { user: 'admin' });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.library.approved, true);
  assert.deepEqual(rebuilds, ['Approve community library anderson']);
  assert.equal((await call('POST', '/anderson/approve', { user: 'admin' })).status, 409);

  await call('POST', '', { user: 'stranger', body: davidson });
  assert.equal((await call('DELETE', '/davidson-county-data-library', { user: 'stranger' })).status, 403);
  assert.equal((await call('DELETE', '/davidson-county-data-library', { user: 'admin' })).status, 200);
  assert.equal(db.rows.has('davidson-county-data-library'), false);
  assert.equal((await call('DELETE', '/knox-county', { user: 'admin' })).status, 409, 'approved libraries are not rejected');
  assert.deepEqual(rebuilds, ['Approve community library anderson'], 'registering and rejecting do not rebuild');
});

test('unknown libraries and routes', async () => {
  const { call } = setup();
  assert.equal((await call('GET', '/nowhere', { user: 'editor' })).status, 404);
  assert.equal((await call('POST', '/knox-county/unknown', { user: 'editor' })).status, 404);
  assert.equal((await call('PATCH', '', { user: 'editor' })).status, 405);
});

test('without a database the function reports it is not configured', async () => {
  const saved = process.env.NETLIFY_DB_URL;
  delete process.env.NETLIFY_DB_URL;
  try {
    const res = await librarianFunction(new Request(`${SITE}/api/librarian/libraries`));
    assert.equal(res.status, 503);
  } finally {
    if (saved !== undefined) process.env.NETLIFY_DB_URL = saved;
  }
});

test('the build hook posts with a trigger title, and skips with a warning when not configured', async () => {
  const warnings: string[] = [];
  const log = { warn: (m: string) => warnings.push(m), error: () => {} };
  assert.equal(await createBuildHook({ url: undefined, log })('Approve community library x'), 'skipped');
  assert.match(warnings[0], /COMMUNITY_BUILD_HOOK_URL is not set/);

  const calls: string[] = [];
  const fetch = (async (url: URL, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    return new Response(null, { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  assert.equal(await createBuildHook({ url: 'https://api.netlify.com/build_hooks/abc', fetch, log })('Approve x'), 'triggered');
  assert.deepEqual(calls, ['POST https://api.netlify.com/build_hooks/abc?trigger_title=Approve+x']);

  const failing = (async () => new Response(null, { status: 500 })) as unknown as typeof globalThis.fetch;
  assert.equal(await createBuildHook({ url: 'https://api.netlify.com/build_hooks/abc', fetch: failing, log })('x'), 'failed');
});
