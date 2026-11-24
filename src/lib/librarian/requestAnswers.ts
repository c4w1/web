/**
 * A co-librarian request as a row with an optional note and two answer buttons, shared by
 * the edit page (a library's editors) and the dashboard (admins, across every library).
 * Answering calls the librarian API: POST .../requests/<email>/accept or
 * DELETE .../requests/<email>, each with { note } when one was typed.
 */

import { LIMITS } from '@lib/community/librarianRules.mjs';
import { api } from './client';

export interface JoinRequest {
  email: string;
  message: string | null;
  requested_at: string;
  /** Set on the dashboard, where requests from every library are listed together. */
  slug?: string;
  name?: string;
}

interface AnswerOptions {
  /** The library the request is for. */
  slug: string;
  /** Button labels. */
  acceptLabel: string;
  declineLabel: string;
  /** Called with the API's answer after a successful accept or decline. */
  onAnswered: (result: { editors?: string[]; requests?: JoinRequest[]; notified?: boolean }, accepted: boolean) => void;
  onError: (message: string) => void;
}

const text = (tag: string, className: string, value: string) => Object.assign(document.createElement(tag), { className, textContent: value });

export function requestRow(req: JoinRequest, options: AnswerOptions): HTMLLIElement {
  const li = document.createElement('li');
  li.dataset.requestEmail = req.email;
  if (req.slug) li.dataset.requestSlug = req.slug;

  const main = document.createElement('div');
  main.className = 'item-main';
  main.append(text('span', 'item-name', req.email));
  if (req.name) main.append(text('span', 'item-meta', `For ${req.name}`));
  main.append(
    text('span', 'item-meta', `Asked ${new Date(req.requested_at).toLocaleDateString()}${req.message ? `: "${req.message}"` : ''}`)
  );

  const note = Object.assign(document.createElement('input'), {
    type: 'text',
    className: 'answer-note',
    maxLength: LIMITS.answerNote,
    placeholder: 'Optional note to the requester',
  });
  note.setAttribute('aria-label', `Note to ${req.email}`);

  const target = `/${encodeURIComponent(options.slug)}/requests/${encodeURIComponent(req.email)}`;
  const answer = (accept: boolean) => async () => {
    buttons.forEach((b) => (b.disabled = true));
    const value = note.value.trim();
    try {
      const result = await api(accept ? `${target}/accept` : target, {
        method: accept ? 'POST' : 'DELETE',
        body: value ? { note: value } : undefined,
      });
      options.onAnswered(result, accept);
    } catch (err) {
      buttons.forEach((b) => (b.disabled = false));
      options.onError(err instanceof Error ? err.message : String(err));
    }
  };

  const accept = Object.assign(document.createElement('button'), { type: 'button', textContent: options.acceptLabel });
  accept.addEventListener('click', answer(true));
  const decline = Object.assign(document.createElement('button'), {
    type: 'button',
    className: 'button-secondary',
    textContent: options.declineLabel,
  });
  decline.addEventListener('click', answer(false));
  const buttons = [accept, decline];

  li.append(main, accept, decline, note);
  return li;
}
