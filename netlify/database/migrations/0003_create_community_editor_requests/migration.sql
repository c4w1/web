-- Requests to become a co-librarian (an editor) of a library, from people who are
-- logged in but are not its editors yet. A library's editors accept a request (the
-- requester becomes an editor) or decline it (the row is deleted); the requester can
-- withdraw it. One open request per person per library.
CREATE TABLE community_editor_requests (
  community_slug text NOT NULL REFERENCES communities (slug) ON DELETE CASCADE,
  email          text NOT NULL CHECK (email = lower(email) AND email LIKE '%_@_%'),
  message        text CHECK (length(message) <= 500),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (community_slug, email)
);

CREATE INDEX community_editor_requests_email ON community_editor_requests (email);
