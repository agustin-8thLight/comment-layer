/* =================================================================
   worker.js — Cloudflare Worker: static site + shared comments (D1).

   Serves your static assets (via the ASSETS binding) and a small JSON
   API under /api that comment-layer.js talks to when its `backend` is
   set to "/api". Backed by Cloudflare D1.

   This file is generic. The only site-specific value is the export
   heading, read from the EXPORT_TITLE var in wrangler.jsonc (falls
   back to a sensible default).

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

  // GET /api/threads?doc=ID
  if (path === "/api/threads" && request.method === "GET") {
    const doc = url.searchParams.get("doc") || "";
    const t = await db.prepare(
      "SELECT id, tab, exact, prefix, suffix FROM threads WHERE doc = ? ORDER BY created ASC"
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
    const threads = t.results.map(r => ({
      id: r.id, tab: r.tab, exact: r.exact, prefix: r.prefix, suffix: r.suffix,
      messages: byThread[r.id] || []
    }));
    return json(threads);
  }

  // POST /api/threads  { doc, thread }
  if (path === "/api/threads" && request.method === "POST") {
    const { doc, thread } = await request.json();
    await db.prepare(
      "INSERT INTO threads (id, doc, tab, exact, prefix, suffix, created) VALUES (?,?,?,?,?,?,?)"
    ).bind(thread.id, doc, thread.tab, thread.exact, thread.prefix, thread.suffix, Date.now()).run();
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
    const t = await db.prepare("SELECT id, tab, exact FROM threads WHERE doc = ? ORDER BY created ASC").bind(doc).all();
    const m = await db.prepare("SELECT thread_id, name, body, ts FROM messages WHERE doc = ? ORDER BY ts ASC").bind(doc).all();
    const byThread = {};
    for (const x of m.results) (byThread[x.thread_id] = byThread[x.thread_id] || []).push(x);

    if (fmt === "json") {
      return json(t.results.map(r => ({
        tab: r.tab, quote: r.exact,
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
        lines.push('### on: “' + r.exact.replace(/\s+/g, " ").trim() + '”', "");
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
