/**
 * Librarian API (served by netlify/functions/librarian-api.mjs).
 *
 * Every route needs a Netlify Identity login. Permission and validation rules live
 * in src/lib/community/librarianRules.mjs; this module wires them to HTTP and to
 * Netlify Database (netlify/lib/communityDb.mjs). Functions only handle these
 * librarian reads and writes; they never read or filter datasets.
 *
 * Routes (all under /api/librarian/libraries):
 *   GET    /                         libraries the user edits and the co-librarian requests the
 *                                     user has open; for admins also pending libraries, every
 *                                     library, and every open co-librarian request
 *   POST   /                         register a library (pending; the user becomes its first editor)
 *   GET    /:slug                    one library with its editors (and open requests, for editors and admins)
 *   PUT    /:slug                    edit a library (editors)
 *   POST   /:slug/editors            add an editor { email } (editors, admins)
 *   DELETE /:slug/editors/:email     remove an editor (editors, admins; never the last one)
 *   GET    /:slug/requests           editors and admins: open co-librarian requests; anyone else:
 *                                     the published library's name and their own request, if any
 *   POST   /:slug/requests           ask to become a co-librarian { message? } (anyone logged in)
 *   POST   /:slug/requests/:email/accept   accept a request { note? }; the requester becomes an
 *                                     editor (editors, admins)
 *   DELETE /:slug/requests/:email    decline a request { note? } (editors, admins) or withdraw your own
 *   POST   /:slug/approve            approve a pending library (admins)
 *   DELETE /:slug                    reject a pending library (admins)
 *
 * Writes check the Origin header (the login is a cookie). Approving a library, or
 * changing a public field of an approved one, rebuilds the site through the build hook.
 * A new co-librarian request is emailed to the library's editors when email is set up, and
 * the requester is emailed the answer (with the optional note) when it is accepted or declined.
 */

import { describeCounty } from '../../src/lib/community/geoVocabulary.mjs';
import {
  canManageEditors,
  checkAddEditor,
  checkAnswerRequest,
  checkJoinRequest,
  checkRegistration,
  checkRemoveEditor,
  checkReview,
  checkUpdate,
  checkWithdrawRequest,
  isAdmin,
  isAllowedOrigin,
  isEditor,
  rebuildReason,
} from '../../src/lib/community/librarianRules.mjs';
import { ConflictError } from './communityDb.mjs';

const MAX_BODY_BYTES = 20_000;
const PREFIX = '/api/librarian/libraries';

/** A JSON body that may also be left out (an empty body reads as {}). */
async function optionalBody(request) {
  const raw = await request.text();
  if (raw.trim() === '') return { value: {} };
  if (raw.length > MAX_BODY_BYTES) return { response: error(413, 'Request is too large.') };
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return { value };
  } catch {
    // fall through
  }
  return { response: error(400, 'Send the details as JSON.') };
}

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

const error = (status, message, errors = []) => json(status, { error: message, errors });
const refused = (check) => error(check.status, check.errors[0]?.message ?? 'Not allowed.', check.errors);

async function readJson(request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return { tooLarge: true };
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : {};
  } catch {
    return {};
  }
}

/** "/api/librarian/libraries/knox-county/editors/a%40b.org" -> ['knox-county', 'editors', 'a@b.org'] */
export function routeParts(pathname) {
  const rest = pathname.replace(/\/+$/, '');
  if (rest !== PREFIX && !rest.startsWith(`${PREFIX}/`)) return null;
  return rest
    .slice(PREFIX.length)
    .split('/')
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
}

/** The edit page on the deployed site, which lives under /web/ (see netlify.toml). */
const defaultEditPageUrl = (origin, slug) => `${origin}/web/librarian/${encodeURIComponent(slug)}/edit/`;

/** The email editors get when someone asks to join their library. */
export function requestEmail({ library, email, message, editPage }) {
  return {
    to: library.editors,
    replyTo: email,
    subject: `${email} asked to become a co-librarian of ${library.name}`,
    text: [
      `${email} asked to become a co-librarian (an editor) of ${library.name} on the Community Data Libraries site.`,
      ...(message ? ['', 'Their note:', '', message] : []),
      '',
      `Accept or decline the request in the librarian portal: ${editPage}`,
      '',
      '---',
      'Reply to this email to answer them directly. You received this because you are an editor',
      'of this library.',
    ].join('\n'),
  };
}

/**
 * The email a requester gets when their co-librarian request is answered. It names the
 * library, not who answered, so editors' and admins' emails stay private.
 */
export function answerEmail({ library, email, accepted, note, editPage }) {
  return {
    to: [email],
    subject: accepted
      ? `You are now a co-librarian of ${library.name}`
      : `Your request to become a co-librarian of ${library.name}`,
    text: [
      accepted
        ? `Your request to become a co-librarian (an editor) of ${library.name} on the Community Data Libraries site was accepted.`
        : `Your request to become a co-librarian (an editor) of ${library.name} on the Community Data Libraries site was declined.`,
      ...(note ? ['', 'A note about your request:', '', note] : []),
      ...(accepted ? ['', `You can edit the library in the librarian portal: ${editPage}`] : []),
      '',
      '---',
      'You received this because you asked to join this library.',
    ].join('\n'),
  };
}

/**
 * @param {object} deps
 * @param {(request: Request) => Promise<{ email: string, roles: string[] } | null>} deps.verifyUser
 * @param {(() => ReturnType<typeof import('./communityDb.mjs').createCommunityDb>) | null} deps.db
 *   null when the site has no database configured.
 * @param {(reason: string) => Promise<string>} deps.rebuild
 * @param {ReturnType<typeof import('../../src/lib/community/geoVocabulary.mjs').createVocabulary>} deps.vocabulary
 * @param {((email: { to: string[], replyTo: string, subject: string, text: string }) => Promise<void>) | null} [deps.send]
 *   Sends email (netlify/lib/libraryContact.mjs createResendSender); null when email isn't set up,
 *   in which case editors see new requests in the portal only.
 * @param {(origin: string, slug: string) => string} [deps.editPageUrl] the portal page where editors answer requests
 */
export function createLibrarianHandler({ verifyUser, db: openDb, rebuild, vocabulary, send = null, editPageUrl = defaultEditPageUrl }) {
  /** A library as the pages show it: stored fields plus state and county names. */
  const view = (community) => ({ ...community, ...(describeCounty(vocabulary, community.county_fips) ?? {}) });

  async function maybeRebuild(action, community, previous) {
    const reason = rebuildReason(action, community, previous);
    return reason ? rebuild(reason) : 'not needed';
  }

  return async function handle(request) {
    const parts = routeParts(new URL(request.url).pathname);
    if (!parts) return error(404, 'Not found');
    if (!openDb) return error(503, 'The librarian portal is not configured on this site yet (no database).');

    const user = await verifyUser(request).catch(() => null);
    if (!user) return error(401, 'Log in with a confirmed email to continue.');
    if (request.method !== 'GET' && !isAllowedOrigin(request)) {
      return error(403, 'This request did not come from the librarian pages of this site.');
    }

    const db = openDb();
    const [slug, sub, subject] = parts;
    if (parts.length > 4) return error(404, 'Not found');
    const method = request.method;

    /** Email the requester the answer to their request; false when email isn't set up or fails. */
    async function notifyRequester(request, library, check, accepted) {
      if (!send) return false;
      try {
        const editPage = editPageUrl(new URL(request.url).origin, library.slug);
        await send(answerEmail({ library, email: check.email, accepted, note: check.note, editPage }));
        return true;
      } catch (err) {
        // The answer is saved either way.
        console.error('librarian-api: answer email failed:', err);
        return false;
      }
    }

    async function body() {
      const parsed = await readJson(request);
      if (parsed.tooLarge) return { response: error(413, 'Request is too large.') };
      if (!parsed.value) return { response: error(400, 'Send the details as JSON.') };
      return { value: parsed.value };
    }

    try {
      // ── Collection ───────────────────────────────────────────────
      if (!slug) {
        if (method === 'GET') {
          const admin = isAdmin(user);
          return json(200, {
            email: user.email,
            isAdmin: admin,
            libraries: (await db.listForEditor(user.email)).map(view),
            pending: admin ? (await db.listPending()).map(view) : [],
            requests: await db.listRequestsBy(user.email),
            // Admins manage co-librarians across every library.
            ...(admin
              ? { allLibraries: (await db.listAllWithEditors()).map(view), allRequests: await db.listAllRequests() }
              : {}),
          });
        }
        if (method === 'POST') {
          const input = await body();
          if (input.response) return input.response;
          const check = checkRegistration({ input: input.value, user, existing: await db.listAll(), vocabulary });
          if (!check.ok) return error(check.status, 'The library could not be registered.', check.errors);
          await db.create(check.community, user.email);
          return json(201, { library: view({ ...check.community, approved: false, editors: check.editors }) });
        }
        return error(405, 'Method not allowed');
      }

      const current = await db.get(slug);
      if (!current) return error(404, 'No such library.');
      const editor = isEditor(current.editors, user.email);
      const manager = canManageEditors(current.editors, user);

      // ── One library ──────────────────────────────────────────────
      if (!sub) {
        if (method === 'GET') {
          if (!manager) return error(403, 'Only this library’s editors can see its settings.');
          const requests = await db.listRequests(slug);
          return json(200, { library: view(current), requests, canEdit: editor, canManageEditors: manager, isAdmin: isAdmin(user) });
        }
        if (method === 'PUT') {
          const input = await body();
          if (input.response) return input.response;
          const others = (await db.listAll()).filter((c) => c.slug !== slug);
          const check = checkUpdate({ current, editors: current.editors, input: input.value, user, existing: others, vocabulary });
          if (!check.ok) return error(check.status, 'The library could not be saved.', check.errors);
          const updated = await db.update(slug, check.community);
          return json(200, {
            library: view({ ...updated, editors: current.editors }),
            rebuild: await maybeRebuild('update', updated, current),
          });
        }
        if (method === 'DELETE') {
          const check = checkReview({ user, community: current });
          if (!check.ok) return refused(check);
          await db.reject(slug);
          return json(200, { rejected: slug });
        }
        return error(405, 'Method not allowed');
      }

      if (sub === 'approve' && !subject) {
        if (method !== 'POST') return error(405, 'Method not allowed');
        const check = checkReview({ user, community: current });
        if (!check.ok) return refused(check);
        const approved = await db.approve(slug, user.email);
        return json(200, {
          library: view({ ...approved, editors: current.editors }),
          rebuild: await maybeRebuild('approve', approved),
        });
      }

      // ── Co-librarian requests (web#71) ───────────────────────────
      if (sub === 'requests') {
        const requests = await db.listRequests(slug);
        const action = parts[3];
        if (method === 'GET' && !subject) {
          if (manager) return json(200, { requests });
          if (!current.approved) return error(404, 'This library isn’t taking co-librarian requests yet.');
          const mine = requests.find((r) => r.email === user.email) ?? null;
          return json(200, { library: { slug, name: current.name }, request: mine });
        }
        if (method === 'POST' && !subject) {
          const input = await body();
          if (input.response) return input.response;
          const check = checkJoinRequest({ community: current, editors: current.editors, requests, user, message: input.value.message });
          if (!check.ok) return refused(check);
          await db.addRequest(slug, check.email, check.message);
          let notified = false;
          if (send) {
            try {
              const editPage = editPageUrl(new URL(request.url).origin, slug);
              await send(requestEmail({ library: current, email: check.email, message: check.message, editPage }));
              notified = true;
            } catch (err) {
              // The request is saved either way; editors also see it in the portal.
              console.error('librarian-api: request email failed:', err);
            }
          }
          return json(201, { request: { email: check.email, message: check.message }, notified });
        }
        if (method === 'POST' && subject && action === 'accept' && parts.length === 4) {
          const input = await optionalBody(request);
          if (input.response) return input.response;
          const check = checkAnswerRequest({ editors: current.editors, requests, user, email: subject, accept: true, note: input.value.note });
          if (!check.ok) return refused(check);
          await db.acceptRequest(slug, check.email, user.email);
          return json(200, {
            editors: [...current.editors, check.email],
            requests: requests.filter((r) => r.email !== check.email),
            notified: await notifyRequester(request, current, check, true),
          });
        }
        if (method === 'DELETE' && subject && parts.length === 3) {
          // Your own request: withdraw it. Someone else's: decline it (editors and admins).
          const own = subject.toLowerCase() === user.email;
          const input = own ? { value: {} } : await optionalBody(request);
          if (input.response) return input.response;
          const check = own
            ? checkWithdrawRequest({ requests, user })
            : checkAnswerRequest({ editors: current.editors, requests, user, email: subject, accept: false, note: input.value.note });
          if (!check.ok) return refused(check);
          await db.deleteRequest(slug, check.email);
          if (own) return json(200, { withdrawn: slug });
          return json(200, {
            requests: requests.filter((r) => r.email !== check.email),
            notified: await notifyRequester(request, current, check, false),
          });
        }
        return error(405, 'Method not allowed');
      }

      if (sub === 'editors') {
        if (method === 'POST' && !subject) {
          const input = await body();
          if (input.response) return input.response;
          const check = checkAddEditor({ editors: current.editors, user, email: input.value.email });
          if (!check.ok) return refused(check);
          await db.addEditor(slug, check.email, user.email);
          return json(201, { editors: [...current.editors, check.email] });
        }
        if (method === 'DELETE' && subject) {
          const check = checkRemoveEditor({ editors: current.editors, user, email: subject });
          if (!check.ok) return refused(check);
          await db.removeEditor(slug, check.email);
          return json(200, { editors: current.editors.filter((e) => e !== check.email) });
        }
        return error(405, 'Method not allowed');
      }
      return error(404, 'Not found');
    } catch (err) {
      if (err instanceof ConflictError) {
        return error(409, 'This library changed or was just registered by someone else. Reload and try again.');
      }
      console.error('librarian-api error:', err);
      return error(502, 'Saving failed. Please try again in a minute.');
    }
  };
}
