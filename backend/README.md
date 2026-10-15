# Shared comments backend (Cloudflare Worker + D1)

The comment layer works with no backend at all: each visitor's comments live in
their own browser (localStorage). That's fine for a solo pass, useless for a
team review, because nobody sees anyone else's notes.

This folder turns on **shared** comments. One Cloudflare Worker serves your
static site and a small JSON API under `/api`, backed by a D1 database. Everyone
who opens the link sees the same threads.

Four files:

| File | What it is |
|------|------------|
| `worker.js` | The Worker. Serves your assets + the `/api` routes. Generic, don't edit. |
| `schema.sql` | The two D1 tables (`threads`, `messages`). |
| `wrangler.jsonc` | Deploy config. Four `>>>` placeholders to fill in, plus optional password-gate vars. |
| `README.md` | This file. |

---

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is plenty).
- Node installed, so you can run `npx wrangler`.
- Your static site as a folder of files (HTML/CSS/JS). The Worker serves it as-is.

## Deploy (one time)

Run these from **this `backend/` directory**.

```bash
# 0. Log in (opens a browser once)
npx wrangler login

# 1. Create the database. Copy the printed database_id.
npx wrangler d1 create my_doc_comments

# 2. Open wrangler.jsonc and fill in the four >>> placeholders:
#      name           your worker/project name
#      assets.directory   path to your site relative to this file (".." if
#                         this folder lives inside the site)
#      database_name  the name from step 1
#      database_id    the id printed in step 1
#    ...and set vars.EXPORT_TITLE to your doc's title.

# 3. Create the tables on the remote DB (use your database_name)
npx wrangler d1 execute my_doc_comments --remote --file=schema.sql

# 4. Ship it (deploys the Worker + uploads your site assets)
npx wrangler deploy
```

Wrangler prints your URL (`https://my-doc-comments.<subdomain>.workers.dev`).

## Point the front end at it

In the page(s) that load `comment-layer.js`, set `backend` to `/api` (same
origin, since the Worker serves both):

```html
<script>
  window.CommentLayer = { docId: "my-doc", backend: "/api" };
</script>
```

Same origin means no CORS and no login. Out of the box **the URL is the only
gate**: anyone with the link can read and comment. See access control below to
lock it down.

## Pull comments back out

- **In the browser:** click **Export** in the toggle control. Downloads a
  Markdown file, every comment grouped by page and the text it sits on. Paste it
  into Claude to triage.
- **From the shared DB (all reviewers at once):**

  ```bash
  curl "https://YOUR-WORKER-URL/api/export?doc=my-doc" -o comments.md
  # or JSON:
  curl "https://YOUR-WORKER-URL/api/export?doc=my-doc&format=json"
  ```

  `doc` must match your `docId`.

---

## Access control

The Worker is public by default. Two built-in ways to restrict it:

- **Cloudflare Access** (recommended when everyone has a company email). Put the
  Worker behind an Access policy so only certain identities can load it. No code
  change.
- **Shared password** (when reviewers are outside your identity provider, e.g.
  a client). Set a secret and the Worker shows a password page in front of every
  page and `/api` route:

  ```bash
  npx wrangler secret put SITE_PASSWORD
  ```

  A correct entry sets a 30-day HttpOnly cookie holding a hash, never the
  password. Set `GATE_TITLE` (the heading on the password page) and
  `GATE_COOKIE` (unique per site, so two review sites never share a session) in
  `wrangler.jsonc`. Delete the secret to open the site again. For local
  `wrangler dev`, put `SITE_PASSWORD=...` in `backend/.dev.vars` (gitignored).

  This relies on `"run_worker_first": true` in `wrangler.jsonc`, which routes
  page requests through the Worker. Keep it, or static files skip the gate.

> **8th Light note.** For internal reviews, scope Cloudflare Access to
> `@8thlight.com`, the same pattern used on other internal review sites. Deploy
> on the 8th Light Cloudflare account. Decide access **before** you circulate
> the link, and don't put confidential client material behind URL-only gating.

## Upgrading an existing deployment

Copy the new `comment-layer.js`, `comment-layer.css` and `worker.js` over the
old ones and run `npx wrangler deploy`. The Worker adds any new columns (pins
added `threads.pin`) on its first request, so there's no migration to run.
Check that your `wrangler.jsonc` has `"run_worker_first": true` under `assets`
if you want the password gate.

## Housekeeping

- **Author-only delete.** A visitor can delete only comments they wrote, matched
  by a random token stored in their browser and sent as `owner`. Light
  moderation, appropriate for an internal doc, not real auth.
- **Multiple docs, one DB.** Every row carries a `doc` column, so one database
  can back several docs. Just give each a distinct `docId`.
- **Wipe everything:**

  ```bash
  npx wrangler d1 execute my_doc_comments --remote \
    --command "DELETE FROM messages; DELETE FROM threads;"
  ```

- **Local comments don't migrate.** Comments made in local-only mode live in one
  browser and are not uploaded when you switch on the backend.
