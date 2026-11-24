/**
 * Stand-ins for the librarian portal's back end in browser tests:
 *
 * - Netlify Identity: a fake nf_jwt cookie plus answers to the Identity endpoints the
 *   @netlify/identity client calls (/settings and /user), so the pages see a logged-in user.
 * - The librarian API: requests to /api/librarian/libraries are answered by the real
 *   handler (netlify/lib/librarianApi.mjs) with the in-memory database the unit tests use,
 *   so the browser exercises the same rules as production.
 */

import type { BrowserContext, Page } from '@playwright/test';
import { createVocabulary } from '../../../src/lib/community/geoVocabulary.mjs';
import { createLibrarianHandler } from '../../../netlify/lib/librarianApi.mjs';
import { createMemoryCommunityDb } from '../../support/memoryCommunityDb.mjs';

export type TestUser = { email: string; roles: string[] };

export const users = {
  editor: { email: 'librarian@knoxdata.org', roles: [] },
  helper: { email: 'helper@knoxdata.org', roles: [] },
  stranger: { email: 'stranger@example.org', roles: [] },
  other: { email: 'other@example.org', roles: [] },
  admin: { email: 'team@cdl.org', roles: ['admin'] },
} satisfies Record<string, TestUser>;

const vocabulary = createVocabulary({
  vintage: 2025,
  states: [{ geoid: '47', name: 'Tennessee', usps: 'TN' }],
  counties: [
    { geoid: '47093', name: 'Knox County', state: 'TN' },
    { geoid: '47001', name: 'Anderson County', state: 'TN' },
  ],
});

/** Two libraries; Knox County has two open co-librarian requests. */
export function seedDb() {
  return createMemoryCommunityDb(
    [
      {
        slug: 'knox-county',
        name: 'Knox County Data Library',
        county_fips: '47093',
        approved: true,
        editors: [users.editor.email, users.helper.email],
      },
      { slug: 'anderson', name: 'Anderson Library', county_fips: '47001', approved: true, editors: ['new@anderson.org'] },
    ],
    [
      { slug: 'knox-county', email: users.stranger.email, message: 'I teach stats at the high school' },
      { slug: 'knox-county', email: users.other.email },
    ]
  );
}

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned JWT: the client only decodes it, and the stand-in API never sees it. */
function fakeJwt(user: TestUser) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: user.email, email: user.email, exp, app_metadata: { roles: user.roles } })}.sig`;
}

async function logIn(context: BrowserContext, baseURL: string, user: TestUser) {
  await context.addCookies([{ name: 'nf_jwt', value: fakeJwt(user), url: baseURL }]);
}

async function fakeIdentity(page: Page, user: TestUser) {
  await page.route('**/.netlify/identity/settings', (route) =>
    route.fulfill({ json: { autoconfirm: false, disable_signup: false, external: { email: true } } })
  );
  await page.route('**/.netlify/identity/user', (route) =>
    route.fulfill({
      json: {
        id: `id-${user.email}`,
        aud: '',
        role: '',
        email: user.email,
        confirmed_at: '2026-01-01T00:00:00Z',
        app_metadata: { provider: 'email', roles: user.roles },
        user_metadata: {},
      },
    })
  );
}

/**
 * Log `user` in on `page` and answer the librarian API from `db`. Returns the emails the
 * API would have sent.
 */
export async function openPortal(page: Page, baseURL: string, user: TestUser, db: ReturnType<typeof seedDb>) {
  const sent: { to: string[]; subject: string; text: string }[] = [];
  const handle = createLibrarianHandler({
    verifyUser: async () => ({ email: user.email, roles: user.roles }),
    db: () => db,
    rebuild: async () => 'skipped',
    vocabulary,
    send: async (email: { to: string[]; subject: string; text: string }) => void sent.push(email),
  });

  await logIn(page.context(), baseURL, user);
  await fakeIdentity(page, user);
  await page.route('**/api/librarian/libraries**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body = request.postData();
    // The page and the API share an origin in production; say so for the write check.
    const response = await handle(
      new Request(url, {
        method: request.method(),
        headers: { Origin: url.origin, 'Content-Type': 'application/json' },
        body: body && !['GET', 'HEAD'].includes(request.method()) ? body : undefined,
      })
    );
    await route.fulfill({ status: response.status, contentType: 'application/json', body: await response.text() });
  });
  return { sent };
}
