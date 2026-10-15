/* =================================================================
   worker.js — Cloudflare Worker: static site + shared comments (D1).

   Serves your static assets (via the ASSETS binding) and a small JSON
   API under /api that comment-layer.js talks to when its `backend` is
   set to "/api". Backed by Cloudflare D1.

   This file is generic. Site-specific values come from wrangler.jsonc
   vars and secrets:
     EXPORT_TITLE   heading for GET /api/export (optional)
     SITE_PASSWORD  secret; when set, pages AND /api sit behind a shared
                    password (see the gate below). Unset = open.

   Routes:
     GET  /api/threads?doc=ID
     POST /api/threads                 { doc, thread }
     POST /api/threads/:id/messages    { doc, message }
     POST /api/threads/:id/delete      { doc, messageId, owner }
     GET  /api/export?doc=ID&format=md|json
   ================================================================= */

const JSON_HEADERS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

/* ---- Optional password gate ----------------------------------------
   Set SITE_PASSWORD as a secret (`npx wrangler secret put SITE_PASSWORD`)
   to require one shared password; leave it unset and the site is open.
   A correct entry sets a 30-day HttpOnly cookie holding a hash, never the
   password itself, and covers pages and /api alike. The cookie name is
   per Worker (GATE_COOKIE var) so two review sites never share a session.
   For identity-based access (e.g. company email), use Cloudflare Access
   instead; see README.md. */

async function gateToken(pw, salt) {
  const data = new TextEncoder().encode("comment-layer-gate-v1|" + salt + "|" + pw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function loginPage(title, toPath, failed) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#141414;
    font-family:system-ui,-apple-system,sans-serif}
  @media (prefers-color-scheme: dark){body{background:#111;color:#f4f4f4}
    input{background:#1b1b1b;color:#f4f4f4;border-color:#333}}
  form{width:min(22rem,86vw)}
  h1{font-size:1.4rem;font-weight:600;letter-spacing:-.01em;margin:0 0 1.2rem}
  input{width:100%;box-sizing:border-box;font:inherit;padding:.7rem .9rem;border:1px solid #d4d4d4;border-radius:6px}
  input:focus{outline:2px solid #2563eb;outline-offset:1px;border-color:#2563eb}
  button{margin-top:.8rem;width:100%;font:inherit;font-weight:600;color:#fff;background:#2563eb;border:0;border-radius:6px;padding:.7rem;cursor:pointer}
  .err{color:#b3261e;font-size:.85rem;margin:.6rem 0 0;${failed ? "" : "display:none"}}
</style></head><body>
<form method="POST" action="/unlock">
  <h1>${esc(title)}</h1>
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" aria-label="Password">
  <input type="hidden" name="to" value="${esc(toPath)}">
  <button type="submit">Open</button>
  <p class="err">That password isn't right. Try again.</p>
</form></body></html>`;
  return new Response(html, { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function gate(request, env, url, path) {
  const cookieName = env.GATE_COOKIE || "cmt_review_auth";
  const expected = await gateToken(env.SITE_PASSWORD, cookieName);
  const cookies = request.headers.get("Cookie") || "";
  if (cookies.split(/;\s*/).includes(`${cookieName}=${expected}`)) return null;

  const title = env.GATE_TITLE || env.EXPORT_TITLE || "Review";
  if (path === "/unlock" && request.method === "POST") {
    const form = await request.formData();
    let to = String(form.get("to") || "/");
    if (!to.startsWith("/") || to.startsWith("//")) to = "/";
    if ((form.get("password") || "") === env.SITE_PASSWORD) {
      return new Response(null, {
        status: 303,
        headers: {
          "Location": to,
          "Set-Cookie": `${cookieName}=${expected}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`
        }
      });
    }
    return loginPage(title, to, true);
  }
  if (path.startsWith("/api/")) return json({ error: "unauthorized" }, 401);
  return loginPage(title, path + url.search, false);
}

/* ---- Schema upkeep -------------------------------------------------
   Pins added a nullable `pin` column. Databases created before it get
   the column on first request, so updating the Worker is enough. */
let schemaChecked = false;
async function ensureSchema(db) {
  if (schemaChecked) return;
  const cols = await db.prepare("PRAGMA table_info(threads)").all();
  if (!cols.results.some(c => c.name === "pin")) {
    await db.prepare("ALTER TABLE threads ADD COLUMN pin TEXT").run();
  }
  schemaChecked = true;
}

function parsePin(raw) {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch (e) { return undefined; }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    if (env.SITE_PASSWORD) {
      const blocked = await gate(request, env, url, path);
      if (blocked) return blocked;
    }

    if (path.startsWith("/api/")) {
      try { return await api(request, env, url, path); }
      catch (e) { return json({ error: String(e) }, 500); }
    }

    // Everything else: serve the static site.
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response("Not found", { status: 404 });
  }
};

async function api(request, env, url, path) {
  const db = env.DB;
  await ensureSchema(db);

  // GET /api/threads?doc=ID
  if (path === "/api/threads" && request.method === "GET") {
    const doc = url.searchParams.get("doc") || "";
    const t = await db.prepare(
      "SELECT id, tab, exact, prefix, suffix, pin FROM threads WHERE doc = ? ORDER BY created ASC"
    ).bind(doc).all();
    const m = await db.prepare(
      "SELECT id, thread_id, name, body, ts, owner FROM messages WHERE doc = ? ORDER BY ts ASC"
    ).bind(doc).all();
    const byThread = {};
    for (const msg of m.results) {
      (byThread[msg.thread_id] = byThread[msg.thread_id] || []).push({
        id: msg.id, name: msg.name, body: msg.body, ts: msg.ts, owner: msg.owner
      });
    }
    const threads = t.results.map(r => {
      const thread = {
        id: r.id, tab: r.tab, exact: r.exact, prefix: r.prefix, suffix: r.suffix,
        messages: byThread[r.id] || []
      };
      const pin = parsePin(r.pin);
      if (pin) thread.pin = pin;
      return thread;
    });
    return json(threads);
  }

  // POST /api/threads  { doc, thread }
  if (path === "/api/threads" && request.method === "POST") {
    const { doc, thread } = await request.json();
    await db.prepare(
      "INSERT INTO threads (id, doc, tab, exact, prefix, suffix, created, pin) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(thread.id, doc, thread.tab, thread.exact, thread.prefix, thread.suffix, Date.now(),
      thread.pin ? JSON.stringify(thread.pin) : null).run();
    const msg = thread.messages[0];
    await db.prepare(
      "INSERT INTO messages (id, thread_id, doc, name, body, ts, owner) VALUES (?,?,?,?,?,?,?)"
    ).bind(msg.id, thread.id, doc, msg.name, msg.body, msg.ts, msg.owner).run();
    return json(thread);
  }

  // POST /api/threads/:id/messages  { doc, message }
  let mm = path.match(/^\/api\/threads\/([^/]+)\/messages$/);
  if (mm && request.method === "POST") {
    const threadId = mm[1];
    const { doc, message } = await request.json();
    await db.prepare(
      "INSERT INTO messages (id, thread_id, doc, name, body, ts, owner) VALUES (?,?,?,?,?,?,?)"
    ).bind(message.id, threadId, doc, message.name, message.body, message.ts, message.owner).run();
    return json(message);
  }

  // POST /api/threads/:id/delete  { doc, messageId, owner }
  let dm = path.match(/^\/api\/threads\/([^/]+)\/delete$/);
  if (dm && request.method === "POST") {
    const threadId = dm[1];
    const { messageId, owner } = await request.json();
    // Only the author (same browser owner token) may delete.
    await db.prepare(
      "DELETE FROM messages WHERE id = ? AND thread_id = ? AND owner = ?"
    ).bind(messageId, threadId, owner).run();
    const left = await db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?"
    ).bind(threadId).first();
    let emptied = false;
    if (left && left.n === 0) {
      await db.prepare("DELETE FROM threads WHERE id = ?").bind(threadId).run();
      emptied = true;
    }
    return json({ emptied });
  }

  // GET /api/export?doc=ID&format=md|json
  if (path === "/api/export" && request.method === "GET") {
    const doc = url.searchParams.get("doc") || "";
    const fmt = url.searchParams.get("format") || "md";
    const title = (env.EXPORT_TITLE || "Review comments");
    const t = await db.prepare("SELECT id, tab, exact, pin FROM threads WHERE doc = ? ORDER BY created ASC").bind(doc).all();
    const m = await db.prepare("SELECT thread_id, name, body, ts FROM messages WHERE doc = ? ORDER BY ts ASC").bind(doc).all();
    const byThread = {};
    for (const x of m.results) (byThread[x.thread_id] = byThread[x.thread_id] || []).push(x);

    if (fmt === "json") {
      return json(t.results.map(r => ({
        tab: r.tab, quote: r.exact, ...(r.pin ? { pin: parsePin(r.pin) } : {}),
        messages: (byThread[r.id] || []).map(z => ({ name: z.name, body: z.body, ts: z.ts }))
      })));
    }

    let total = 0; for (const k in byThread) total += byThread[k].length;
    const lines = ["# " + title, "",
      `_${t.results.length} threads, ${total} comments, exported ${new Date().toISOString().slice(0, 10)}_`, ""];
    // Group by tab (page id), in first-seen order.
    const order = [];
    for (const r of t.results) if (order.indexOf(r.tab) === -1) order.push(r.tab);
    for (const tab of order) {
      const inTab = t.results.filter(r => r.tab === tab);
      lines.push("## " + tab, "");
      for (const r of inTab) {
        lines.push("### " + (r.pin ? "pin on" : "on") + ': “' + r.exact.replace(/\s+/g, " ").trim() + '”', "");
        for (const z of (byThread[r.id] || [])) {
          lines.push("- **" + z.name + "** (" + new Date(z.ts).toISOString().slice(0, 10) + "): " + z.body.replace(/\s*\n\s*/g, " ").trim());
        }
        lines.push("");
      }
    }
    return new Response(lines.join("\n"), {
      headers: { "Content-Type": "text/markdown; charset=utf-8", "Access-Control-Allow-Origin": "*" }
    });
  }

  return json({ error: "not found" }, 404);
}
