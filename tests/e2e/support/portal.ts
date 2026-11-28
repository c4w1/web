/**
 * Stand-ins for the librarian portal's back end in browser tests:
 *
 * - Netlify Identity: answers to the endpoints the @netlify/identity client calls
 *   (/settings, /token, /user, /logout), backed by a list of test accounts, so pages can
 *   log in and out for real. Tokens are unsigned JWTs: the client only decodes them.
 * - The librarian API: requests to /api/librarian/libraries are answered by the real
 *   handler (netlify/lib/librarianApi.mjs) with the in-memory database the unit tests use,
 *   so the browser exercises the same rules as production. The API knows who is logged
 *   in from the nf_jwt cookie, as the deployed function does.
 */

import type { Page, Request as PlaywrightRequest } from '@playwright/test';
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

/** Every test account's password (the stand-in Identity accepts only this one). */
export const PASSWORD = 'correct-horse-battery';

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
      {
        slug: 'anderson',
        name: 'Anderson Library',
        county_fips: '47001',
        approved: true,
        editors: ['new@anderson.org'],
      },
    ],
    [
      {
        slug: 'knox-county',
        email: users.stranger.email,
        message: 'I teach stats at the high school',
      },
      { slug: 'knox-county', email: users.other.email },
    ]
  );
}

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** An unsigned JWT for `user`: the client only decodes it, and so does the stand-in API. */
export function fakeJwt(user: TestUser) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: user.email, email: user.email, exp, app_metadata: { roles: user.roles } })}.sig`;
}

function emailFromJwt(jwt: string | undefined | null): string | null {
  try {
    const payload = JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString());
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}

function cookie(header: string | undefined, name: string): string | null {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

const identityUser = (user: TestUser) => ({
  id: `id-${user.email}`,
  aud: '',
  role: '',
  email: user.email,
  confirmed_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email', roles: user.roles },
  user_metadata: {},
});

/**
 * Answer Netlify Identity and the librarian API on `page` for `accounts` (all with
 * PASSWORD). Nobody is logged in until the page logs in, or a test sets the nf_jwt cookie
 * (see openPortal). Returns the emails the API would have sent.
 */
export async function startBackend(
  page: Page,
  db: ReturnType<typeof seedDb>,
  accounts: TestUser[] = Object.values(users)
) {
  const sent: { to: string[]; subject: string; text: string }[] = [];
  const account = (email: string | null) =>
    accounts.find((a) => a.email === email?.toLowerCase()) ?? null;

  await page.route('**/.netlify/identity/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^.*\/\.netlify\/identity/, '');
    if (path === '/settings') {
      return route.fulfill({
        json: { autoconfirm: false, disable_signup: false, external: { email: true } },
      });
    }
    if (path === '/token' && request.method() === 'POST') {
      const form = new URLSearchParams(request.postData() ?? '');
      const user =
        form.get('grant_type') === 'password' && form.get('password') === PASSWORD
          ? account(form.get('username'))
          : null;
      if (!user) {
        return route.fulfill({
          status: 400,
          json: {
            error: 'invalid_grant',
            error_description: 'No user found with that email, or password invalid.',
          },
        });
      }
      return route.fulfill({
        json: {
          access_token: fakeJwt(user),
          token_type: 'bearer',
          expires_in: 3600,
          refresh_token: `refresh-${user.email}`,
        },
      });
    }
    if (path === '/user') {
      const bearer = (await request.allHeaders()).authorization?.replace(/^Bearer\s+/i, '');
      const user = account(emailFromJwt(bearer));
      return user
        ? route.fulfill({ json: identityUser(user) })
        : route.fulfill({ status: 401, json: { msg: 'Invalid token' } });
    }
    if (path === '/logout') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ status: 404, json: { msg: `No stand-in for ${path}` } });
  });

  // The deployed function reads the login from the nf_jwt cookie; so does this one.
  let current: TestUser | null = null;
  const handle = createLibrarianHandler({
    verifyUser: async () => current,
    db: () => db,
    rebuild: async () => 'skipped',
    vocabulary,
    send: async (email: { to: string[]; subject: string; text: string }) => void sent.push(email),
  });

  await page.route('**/api/librarian/libraries**', async (route) => {
    const request: PlaywrightRequest = route.request();
    const url = new URL(request.url());
    const headers = await request.allHeaders();
    current = account(emailFromJwt(cookie(headers.cookie, 'nf_jwt')));
    const body = request.postData();
    // The page and the API share an origin in production; say so for the write check.
    const response = await handle(
      new Request(url, {
        method: request.method(),
        headers: { Origin: url.origin, 'Content-Type': 'application/json' },
        body: body && !['GET', 'HEAD'].includes(request.method()) ? body : undefined,
      })
    );
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: await response.text(),
    });
  });
  return { sent };
}

/** `user` already logged in (an nf_jwt cookie, as after a login), with the stand-in back end. */
export async function openPortal(
  page: Page,
  baseURL: string,
  user: TestUser,
  db: ReturnType<typeof seedDb>
) {
  await page.context().addCookies([{ name: 'nf_jwt', value: fakeJwt(user), url: baseURL }]);
  return startBackend(page, db);
}

/** The nf_jwt cookie the browser holds for the site, if any. */
export async function loginCookie(page: Page, baseURL: string) {
  return (await page.context().cookies(baseURL)).find((c) => c.name === 'nf_jwt')?.value ?? null;
}
