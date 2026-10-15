/* =================================================================
   comment-layer.js — highlight-to-comment for any HTML page.

   Select text anywhere in the page body, leave a comment. Comments
   anchor to the text itself (the quote plus a little surrounding
   context), so they survive markup tweaks and re-renders. In
   commenting mode a plain click drops a pin instead, for things that
   aren't text (images, layout, spacing). A name is required and
   remembered. A top-bar control switches between viewing (links live)
   and commenting (in-view links inert, select or click to annotate)
   modes, and exports all comments as Markdown.

   Zero dependencies, zero build step. Drop in this file plus
   comment-layer.css and it works using each visitor's own browser
   (localStorage). Point `backend` at the Worker (see backend/) to
   share comments across a team.

   ALL configuration lives in a single global set BEFORE this script
   loads. You never edit this file:

     <script>
       window.CommentLayer = {
         docId: "my-doc",          // namespaces the storage
         backend: null,            // "/api" to share, null = local only
         viewSelector: "main",     // where selectable text lives
       };
     </script>
     <link rel="stylesheet" href="comment-layer.css">
     <script src="comment-layer.js" defer></script>

   See docs/INTEGRATION.md for every option.
   ================================================================= */
(function () {
  "use strict";

  /* ---- Config --------------------------------------------------- */
  var CFG = (window.CommentLayer && typeof window.CommentLayer === "object") ? window.CommentLayer : {};

  // Note: <a> is intentionally NOT skipped. Link text is commentable;
  // commenting mode makes in-view links inert so selecting them is clean.
  // Only the page-level <header> is skipped: a <header> inside the view
  // is usually a section or page intro, which reviewers want to quote.
  var DEFAULT_SKIP =
    "nav, body > header, [role=banner], footer, aside, button, code, pre, script, style, " +
    "input, textarea, select, [contenteditable], " +
    ".cmt-pop, .cmt-bubble, .cmt-tools, .cmt-pin, [data-cmt-skip]";

  var DOC_ID   = CFG.docId || "comments";
  // Local-only by default. Set backend to a base path (e.g. "/api") to share.
  var BACKEND  = ("backend" in CFG) ? CFG.backend : null;
  var CTX      = CFG.context || 40;            // chars of context stored each side
  // Election is priority-ordered: first selector that matches wins (see viewRoot).
  var VIEW_SEL = CFG.viewSelector || "main, #main, .content, article, #content, body";
  var SKIP_SEL = CFG.skipSelector || DEFAULT_SKIP;
  var PAGES    = Array.isArray(CFG.pages) ? CFG.pages : [];   // optional [id,label] pairs for export
  var TITLE    = CFG.title || (DOC_ID + " comments");         // export heading
  var EXPORT_FILE = CFG.exportFilename || (DOC_ID + "-comments.md");
  // Where the toggle/export control gets injected. First match wins;
  // if nothing matches, a floating control is created (see buildToggle).
  var TOGGLE_HOST = CFG.toggleHost ||
    ".cmt-host, .footer-tools, .site-footer, .header-inner, .site-header, header, footer";
  // Re-render on client-side navigation: hashchange, history.pushState /
  // replaceState, and popstate. Needed for SPAs and framework routers
  // (Next <Link>, React Router) that swap pages without a reload.
  var SPA      = !!CFG.spa;
  // Which mode a reader lands in. "view" (default) keeps links live.
  var DEFAULT_MODE = (CFG.defaultMode === "comment") ? "comment" : "view";
  // Click (no drag) in commenting mode drops a pin. On by default.
  var PINS     = CFG.pins !== false;
  // false = viewing mode shows the design untouched: no highlight tint,
  // no pins, clicks pass through. Commenting mode still shows everything.
  var VIEW_MARKS = CFG.showInView !== false;

  var LS = {
    name:   "cmt-name-" + DOC_ID,
    owner:  "cmt-owner",
    mode:   "cmt-mode-" + DOC_ID,
    data:   "cmt-data-" + DOC_ID
  };

  /* ---- Small helpers -------------------------------------------- */
  function uid(p) { return (p || "c") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7); }
  function el(tag, cls, txt) { var e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function owner() { var t = localStorage.getItem(LS.owner); if (!t) { t = uid("o"); localStorage.setItem(LS.owner, t); } return t; }

  // Priority-ordered root election. document.querySelector on a list
  // returns the first match in DOM order (so "main, body" would pick
  // body, its ancestor); iterating keeps selector precedence instead.
  function viewRoot() {
    var sels = VIEW_SEL.split(",");
    for (var i = 0; i < sels.length; i++) {
      var e = document.querySelector(sels[i].trim());
      if (e) return e;
    }
    return document.body;
  }

  function ago(ts) {
    var s = (Date.now() - ts) / 1000;
    if (s < 45) return "just now";
    var m = s / 60; if (m < 60) return Math.round(m) + "m ago";
    var h = m / 60; if (h < 24) return Math.round(h) + "h ago";
    var d = h / 24; if (d < 7) return Math.round(d) + "d ago";
    return new Date(ts).toLocaleDateString();
  }
  function commonPrefix(a, b) { var n = 0; while (n < a.length && n < b.length && a[n] === b[n]) n++; return n; }
  function commonSuffix(a, b) { var n = 0; while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++; return n; }

  /* The current page id: the pathname relative to the site root,
     normalized to extensionless form so clean URLs, .html URLs, and
     local file:// previews all resolve to the same tab. */
  function currentView() {
    var p = location.pathname.replace(/^\//, "").replace(/\.html?$/, "").replace(/\/$/, "");
    if (!p) p = "index";
    return p;
  }
  function pageLabel(tab) {
    for (var i = 0; i < PAGES.length; i++) if (PAGES[i][0] === tab) return PAGES[i][1];
    return tab;
  }

  /* ---- Storage adapter ------------------------------------------ */
  /* Thread shape:
       { id, tab, exact, prefix, suffix, pin?,
         messages: [ { id, name, body, ts, owner } ] }
     A text comment has no `pin`. A pin has `pin` = { path, x, y, rx, ry }
     and `exact` holds a short label of what it sits on (for export).  */
  var threads = [];

  var Store = {
    load: function () {
      if (BACKEND) {
        return fetch(BACKEND + "/threads?doc=" + encodeURIComponent(DOC_ID))
          .then(function (r) { return r.json(); })
          .then(function (rows) { threads = rows || []; return threads; })
          .catch(function () { threads = []; return threads; });
      }
      try { threads = JSON.parse(localStorage.getItem(LS.data) || "[]"); }
      catch (e) { threads = []; }
      return Promise.resolve(threads);
    },
    _persistLocal: function () { localStorage.setItem(LS.data, JSON.stringify(threads)); },

    addThread: function (anchor, message) {
      var thread = {
        id: uid("t"), tab: anchor.tab, exact: anchor.exact,
        prefix: anchor.prefix, suffix: anchor.suffix, messages: [message]
      };
      if (anchor.pin) thread.pin = anchor.pin;
      if (BACKEND) {
        return fetch(BACKEND + "/threads", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc: DOC_ID, thread: thread })
        }).then(function (r) { return r.json(); }).then(function (saved) {
          threads.push(saved); return saved;
        });
      }
      threads.push(thread); this._persistLocal(); return Promise.resolve(thread);
    },

    addMessage: function (threadId, message) {
      var t = threads.filter(function (x) { return x.id === threadId; })[0];
      if (!t) return Promise.resolve(null);
      if (BACKEND) {
        return fetch(BACKEND + "/threads/" + threadId + "/messages", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc: DOC_ID, message: message })
        }).then(function (r) { return r.json(); }).then(function (saved) {
          t.messages.push(saved); return saved;
        });
      }
      t.messages.push(message); this._persistLocal(); return Promise.resolve(message);
    },

    deleteMessage: function (threadId, messageId) {
      var t = threads.filter(function (x) { return x.id === threadId; })[0];
      if (!t) return Promise.resolve();
      t.messages = t.messages.filter(function (m) { return m.id !== messageId; });
      var emptied = t.messages.length === 0;
      if (emptied) threads = threads.filter(function (x) { return x.id !== threadId; });
      if (BACKEND) {
        return fetch(BACKEND + "/threads/" + threadId + "/delete", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ doc: DOC_ID, messageId: messageId, owner: owner() })
        }).then(function () { return { emptied: emptied }; });
      }
      this._persistLocal(); return Promise.resolve({ emptied: emptied });
    }
  };

  /* ---- Text mapping & anchoring --------------------------------- */
  function textMap(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (p && p.closest(SKIP_SEL)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var text = "", map = [], node;
    while ((node = walker.nextNode())) { map.push({ node: node, start: text.length }); text += node.nodeValue; }
    return { text: text, map: map };
  }

  function globalIndex(map, node, offset) {
    for (var i = 0; i < map.length; i++) if (map[i].node === node) return map[i].start + offset;
    return -1;
  }

  function captureAnchor() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    var range = sel.getRangeAt(0);
    if (!range.toString().trim()) return null;
    var startEl = range.startContainer.parentElement;
    if (!startEl) return null;
    var root = startEl.closest(VIEW_SEL);
    if (!root || (startEl.closest && startEl.closest(SKIP_SEL))) return null;
    var m = textMap(root);
    var start = globalIndex(m.map, range.startContainer, range.startOffset);
    var end   = globalIndex(m.map, range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) return null;
    return {
      tab: currentView(),
      exact: m.text.slice(start, end),
      prefix: m.text.slice(Math.max(0, start - CTX), start),
      suffix: m.text.slice(end, end + CTX),
      rect: range.getBoundingClientRect()
    };
  }

  /* ---- Pin anchoring -------------------------------------------- */
  /* A pin anchors to the element under the click (a structural path from
     the view root) plus where inside it the click landed, as fractions of
     its box, so the pin tracks the element through resizes and reflow.
     rx/ry (fractions of the root's box) are the fallback when the path no
     longer resolves after the markup changed. */
  function elPath(root, node) {
    var parts = [];
    while (node && node !== root && node.nodeType === 1) {
      if (node.id && !/^cmt-/.test(node.id)) { parts.unshift("#" + CSS.escape(node.id)); break; }
      var i = 1, sib = node;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) i++;
      parts.unshift(node.tagName.toLowerCase() + ":nth-of-type(" + i + ")");
      node = node.parentElement;
    }
    return parts.join(" > ");
  }
  function resolvePath(root, path) {
    if (!path) return root;
    try { return root.querySelector(path.charAt(0) === "#" ? path : ":scope > " + path); }
    catch (e) { return null; }
  }
  function ownLabel(node) {
    var t = (node.getAttribute && (node.getAttribute("alt") || node.getAttribute("aria-label"))) ||
      (node.textContent || "").replace(/\s+/g, " ").trim();
    return t.length > 80 ? t.slice(0, 80) + "…" : t;
  }
  // What the pin sits on, for the composer and the export. An element
  // with no text of its own (an image with empty alt, a box) borrows the
  // text of its nearest labelled ancestor: "<img> in Artist name".
  function pinLabel(node) {
    var t = ownLabel(node);
    if (t) return t;
    var tag = "<" + node.tagName.toLowerCase() + ">", up = node.parentElement;
    for (var i = 0; up && i < 4 && up !== viewRoot(); i++, up = up.parentElement) {
      var u = ownLabel(up);
      if (u) return tag + " in " + u;
    }
    return tag;
  }
  function capturePin(e) {
    var root = viewRoot();
    var target = e.target;
    if (!root || !target || target.nodeType !== 1 || !root.contains(target)) return null;
    if (target.closest(SKIP_SEL)) return null;
    var r = target.getBoundingClientRect(), rr = root.getBoundingClientRect();
    var rect = { top: e.clientY, bottom: e.clientY, left: e.clientX, width: 0, height: 0 };
    return {
      tab: currentView(),
      exact: pinLabel(target), prefix: "", suffix: "",
      pin: {
        path: elPath(root, target),
        x: r.width ? (e.clientX - r.left) / r.width : 0,
        y: r.height ? (e.clientY - r.top) / r.height : 0,
        rx: rr.width ? (e.clientX - rr.left) / rr.width : 0,
        ry: rr.height ? (e.clientY - rr.top) / rr.height : 0
      },
      rect: rect
    };
  }
  // Page coordinates for a pin, or null if its element is gone or hidden.
  function pinPoint(root, pin) {
    var target = resolvePath(root, pin.path), box, fx = pin.x, fy = pin.y;
    if (!target) { target = root; fx = pin.rx; fy = pin.ry; }
    box = target.getBoundingClientRect();
    if (!box.width && !box.height) return null;
    return { x: window.scrollX + box.left + fx * box.width, y: window.scrollY + box.top + fy * box.height, el: target };
  }

  /* ---- Highlight rendering -------------------------------------- */
  function unwrap(root) {
    var mk;
    while ((mk = root.querySelector("mark.cmt-hl"))) {
      mk.replaceWith(document.createTextNode(mk.textContent));
    }
    root.normalize();
  }
  function wrapPortion(node, s, e, cid) {
    var txt = node.nodeValue;
    var frag = document.createDocumentFragment();
    if (s > 0) frag.appendChild(document.createTextNode(txt.slice(0, s)));
    var mk = el("mark", "cmt-hl"); mk.setAttribute("data-cid", cid); mk.textContent = txt.slice(s, e);
    frag.appendChild(mk);
    if (e < txt.length) frag.appendChild(document.createTextNode(txt.slice(e)));
    node.parentNode.replaceChild(frag, node);
  }
  function renderRoot() {
    var root = viewRoot();
    if (!root) return;
    unwrap(root);
    root.classList.toggle("cmt-commenting", mode() === "comment");
    var tab = currentView();
    threads.filter(function (t) { return t.tab === tab; }).forEach(function (t) {
      if (!t.exact || t.pin) return;
      var m = textMap(root);
      // Re-anchor: find every occurrence of the quote, score each by how
      // much of the stored context still surrounds it, keep the best.
      var idx = -1, best = -1, bestScore = -1, from = 0;
      while ((idx = m.text.indexOf(t.exact, from)) !== -1) {
        var pre = m.text.slice(Math.max(0, idx - t.prefix.length), idx);
        var suf = m.text.slice(idx + t.exact.length, idx + t.exact.length + t.suffix.length);
        var score = commonSuffix(pre, t.prefix) + commonPrefix(suf, t.suffix);
        if (score > bestScore) { bestScore = score; best = idx; }
        from = idx + 1;
      }
      if (best < 0) return;
      var start = best, end = best + t.exact.length, tasks = [];
      for (var i = 0; i < m.map.length; i++) {
        var seg = m.map[i], segStart = seg.start, segEnd = seg.start + seg.node.nodeValue.length;
        if (segEnd <= start || segStart >= end) continue;
        tasks.push({ node: seg.node, s: Math.max(start, segStart) - segStart, e: Math.min(end, segEnd) - segStart });
      }
      tasks.forEach(function (task) { wrapPortion(task.node, task.s, task.e, t.id); });
    });
  }

  /* Pins live in one absolutely positioned layer on <body>, outside the
     view, so they never disturb the text map or the page's own layout. */
  var pinLayer = null, pendingPin = null;
  function pinNode(cls, label) {
    var b = el("button", "cmt-pin" + (cls ? " " + cls : ""));
    b.type = "button";
    b.appendChild(el("span", "cmt-pin-label", label));
    return b;
  }
  function placePin(node, pt) {
    if (!pt) { node.style.display = "none"; return; }
    node.style.display = ""; node.style.left = pt.x + "px"; node.style.top = pt.y + "px";
  }
  function renderPins() {
    if (!pinLayer) { pinLayer = el("div", "cmt-pins"); document.body.appendChild(pinLayer); }
    while (pinLayer.firstChild) pinLayer.removeChild(pinLayer.firstChild);
    var root = viewRoot();
    if (!root) return;
    var tab = currentView(), n = 0;
    threads.filter(function (t) { return t.tab === tab && t.pin; }).forEach(function (t) {
      n++;
      var b = pinNode("", String(n));
      b.setAttribute("data-cid", t.id);
      b.setAttribute("aria-label", "Pinned comment " + n + " by " + (t.messages[0] ? t.messages[0].name : ""));
      b.title = t.messages[0] ? t.messages[0].name + ": " + t.messages[0].body.slice(0, 80) : "";
      b.addEventListener("click", function (e) { e.stopPropagation(); openThread(t.id); });
      placePin(b, pinPoint(root, t.pin));
      pinLayer.appendChild(b);
    });
    if (pendingPin) pinLayer.appendChild(pendingPin.node);
  }
  function positionPins() {
    if (!pinLayer) return;
    var root = viewRoot();
    if (!root) return;
    Array.prototype.forEach.call(pinLayer.querySelectorAll(".cmt-pin[data-cid]"), function (b) {
      var t = threads.filter(function (x) { return x.id === b.getAttribute("data-cid"); })[0];
      if (t) placePin(b, pinPoint(root, t.pin));
    });
    if (pendingPin) placePin(pendingPin.node, pinPoint(root, pendingPin.pin));
  }
  function clearPendingPin() { if (pendingPin) { pendingPin.node.remove(); pendingPin = null; } }

  // The element a thread is drawn on: its first highlight, or its pin.
  function anchorEl(threadId) {
    return document.querySelector('mark.cmt-hl[data-cid="' + threadId + '"]') ||
      document.querySelector('.cmt-pin[data-cid="' + threadId + '"]');
  }

  function renderAll() {
    renderRoot();
    renderPins();
    updateCount();
  }

  /* ---- UI: floating bubble -------------------------------------- */
  var bubble = null, pendingAnchor = null;
  function clearBubble() { if (bubble) { bubble.remove(); bubble = null; } }
  function showBubble(anchor) {
    clearBubble();
    pendingAnchor = anchor;
    bubble = el("button", "cmt-bubble");
    bubble.type = "button";
    bubble.innerHTML = '<span aria-hidden="true">&#9998;</span> Comment';
    bubble.style.top = (window.scrollY + anchor.rect.top - 8) + "px";
    bubble.style.left = (window.scrollX + anchor.rect.left + anchor.rect.width / 2) + "px";
    bubble.addEventListener("mousedown", function (e) { e.preventDefault(); });
    bubble.addEventListener("click", function (e) {
      e.stopPropagation();
      var a = pendingAnchor; clearBubble();
      window.getSelection().removeAllRanges();
      // Starting a comment from viewing mode flips the reader into
      // commenting mode (links go inert), then opens the composer.
      if (mode() !== "comment") setMode("comment");
      openComposer(a);
    });
    document.body.appendChild(bubble);
  }

  /* ---- UI: popovers --------------------------------------------- */
  var pop = null;
  function clearPop() { if (pop) { pop.remove(); pop = null; } clearPendingPin(); setActive(null); }
  function placePop(node, rect) {
    var top = window.scrollY + rect.bottom + 8;
    var left = window.scrollX + rect.left;
    node.style.top = top + "px"; node.style.left = left + "px"; node.style.visibility = "hidden";
    document.body.appendChild(node);
    var w = node.offsetWidth, vw = document.documentElement.clientWidth;
    if (rect.left + w > vw - 12) left = window.scrollX + Math.max(12, vw - w - 12);
    node.style.left = left + "px"; node.style.visibility = "";
  }
  function popShell(title) {
    var p = el("div", "cmt-pop");
    var head = el("div", "cmt-pop-head");
    head.appendChild(el("span", "cmt-pop-title", title));
    var x = el("button", "cmt-x"); x.type = "button"; x.innerHTML = "&times;"; x.setAttribute("aria-label", "Close");
    x.addEventListener("click", clearPop);
    head.appendChild(x);
    p.appendChild(head);
    return p;
  }
  function nameField(value) {
    var i = el("input", "cmt-name"); i.type = "text"; i.placeholder = "Your name (required)";
    i.value = value || ""; i.maxLength = 60; return i;
  }

  // The quoted passage, or for a pin, a label of what it sits on.
  function quoteBlock(thread, max) {
    if (thread.pin) return el("p", "cmt-quote cmt-quote--pin", "Pinned on: " + thread.exact);
    return el("p", "cmt-quote", thread.exact.length > max ? thread.exact.slice(0, max) + "…" : thread.exact);
  }

  function openComposer(anchor) {
    clearPop();
    if (anchor.pin) {
      // A provisional pin marks the spot while the comment is written.
      pendingPin = { pin: anchor.pin, node: pinNode("cmt-pin--pending", "+") };
      pendingPin.node.setAttribute("aria-hidden", "true");
      pendingPin.node.tabIndex = -1;
      renderPins();
      placePin(pendingPin.node, pinPoint(viewRoot(), anchor.pin));
    }
    var p = popShell(anchor.pin ? "New pin" : "New comment");
    p.appendChild(quoteBlock(anchor, 220));
    var body = el("div", "cmt-body");
    var form = el("form", "cmt-form");
    var name = nameField(localStorage.getItem(LS.name));
    var text = el("textarea", "cmt-text"); text.placeholder = "Your comment";
    var actions = el("div", "cmt-actions");
    var cancel = el("button", "cmt-btn cmt-btn-ghost", "Cancel"); cancel.type = "button";
    var save = el("button", "cmt-btn", "Comment"); save.type = "submit"; save.disabled = true;
    function validate() { save.disabled = !(name.value.trim() && text.value.trim()); }
    name.addEventListener("input", validate); text.addEventListener("input", validate);
    cancel.addEventListener("click", clearPop);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (save.disabled) return;
      localStorage.setItem(LS.name, name.value.trim());
      var msg = { id: uid("m"), name: name.value.trim(), body: text.value.trim(), ts: Date.now(), owner: owner() };
      save.disabled = true;
      Store.addThread(anchor, msg).then(function (thread) {
        renderAll(); clearPop();
        openThread(thread.id);
      });
    });
    actions.appendChild(cancel); actions.appendChild(save);
    form.appendChild(name); form.appendChild(text); form.appendChild(actions);
    body.appendChild(form);
    p.appendChild(body);
    pop = p;
    placePop(p, anchor.rect);
    setTimeout(function () { (name.value ? text : name).focus(); }, 30);
  }

  function openThread(threadId) {
    var thread = threads.filter(function (t) { return t.id === threadId; })[0];
    if (!thread) return;
    var mark = anchorEl(threadId);
    if (!mark) return;
    clearPop();
    setActive(threadId);
    var p = popShell("Comment" + (thread.messages.length > 1 ? "s" : ""));
    p.appendChild(quoteBlock(thread, 160));
    var body = el("div", "cmt-body");
    var list = el("div", "cmt-msgs");
    thread.messages.forEach(function (m) {
      var item = el("div", "cmt-msg");
      var top = el("div", "cmt-msg-top");
      top.appendChild(el("span", "cmt-msg-name", m.name));
      top.appendChild(el("span", "cmt-msg-time", ago(m.ts)));
      if (m.owner === owner()) {
        var del = el("button", "cmt-msg-del"); del.type = "button"; del.innerHTML = "&times;"; del.title = "Delete";
        del.addEventListener("click", function () {
          Store.deleteMessage(thread.id, m.id).then(function (res) {
            renderAll();
            if (res && res.emptied) clearPop(); else openThread(thread.id);
          });
        });
        top.appendChild(del);
      }
      item.appendChild(top);
      item.appendChild(el("p", "cmt-msg-body", m.body));
      list.appendChild(item);
    });
    body.appendChild(list);

    var form = el("form", "cmt-form");
    var name = nameField(localStorage.getItem(LS.name));
    var text = el("textarea", "cmt-text"); text.placeholder = "Reply";
    var actions = el("div", "cmt-actions");
    var save = el("button", "cmt-btn", "Reply"); save.type = "submit"; save.disabled = true;
    function validate() { save.disabled = !(name.value.trim() && text.value.trim()); }
    name.addEventListener("input", validate); text.addEventListener("input", validate);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (save.disabled) return;
      localStorage.setItem(LS.name, name.value.trim());
      var msg = { id: uid("m"), name: name.value.trim(), body: text.value.trim(), ts: Date.now(), owner: owner() };
      save.disabled = true;
      Store.addMessage(thread.id, msg).then(function () { renderAll(); openThread(thread.id); });
    });
    form.appendChild(name); form.appendChild(text); form.appendChild(actions); actions.appendChild(save);
    body.appendChild(form);
    p.appendChild(body);
    pop = p;
    placePop(p, mark.getBoundingClientRect());
  }

  function setActive(cid) {
    Array.prototype.forEach.call(document.querySelectorAll('.cmt-hl[data-active="true"], .cmt-pin[data-active="true"]'),
      function (m) { m.removeAttribute("data-active"); });
    if (cid) Array.prototype.forEach.call(document.querySelectorAll('.cmt-hl[data-cid="' + cid + '"], .cmt-pin[data-cid="' + cid + '"]'),
      function (m) { m.setAttribute("data-active", "true"); });
  }

  /* ---- Export comments (Markdown) ------------------------------- */
  // Heading nearest above the highlight, used as a section label in the
  // export. Only resolvable for the page currently in the DOM.
  function sectionFor(t) {
    var root = viewRoot();
    var mk = null;
    if (t.pin) { if (t.tab === currentView() && root) { var pt = pinPoint(root, t.pin); mk = pt && pt.el; } }
    else mk = document.querySelector('mark.cmt-hl[data-cid="' + t.id + '"]');
    if (!mk) return null;
    var heads = root ? root.querySelectorAll("h1, h2") : [];
    var best = null;
    for (var i = 0; i < heads.length; i++) {
      if (mk.compareDocumentPosition(heads[i]) & Node.DOCUMENT_POSITION_PRECEDING) best = heads[i];
    }
    return best ? best.textContent.trim() : null;
  }
  function exportMarkdown() {
    var total = 0; threads.forEach(function (t) { total += t.messages.length; });
    var out = ["# " + TITLE, "",
      "_" + threads.length + " threads, " + total + " comments, exported " + new Date().toLocaleString() + "_", ""];
    if (!threads.length) { out.push("_No comments yet._"); return out.join("\n"); }

    function pushThread(t) {
      var sec = sectionFor(t);
      var quote = t.exact.replace(/\s+/g, " ").trim();
      out.push("### " + (sec ? sec + ": " : "") + (t.pin ? "pin on: " : "on: ") + "“" + quote + "”", "");
      t.messages.forEach(function (m) {
        out.push("- **" + m.name + "** (" + new Date(m.ts).toLocaleDateString() + "): " + m.body.replace(/\s*\n\s*/g, " ").trim());
      });
      out.push("");
    }

    // Grouped by page. If PAGES is set, use that order and labels;
    // otherwise fall back to first-seen page order with raw ids.
    var order = PAGES.length ? PAGES.map(function (p) { return p[0]; }) : [];
    if (!order.length) {
      threads.forEach(function (t) { if (order.indexOf(t.tab) === -1) order.push(t.tab); });
    }
    var seen = {};
    order.forEach(function (tab) {
      seen[tab] = true;
      var inTab = threads.filter(function (t) { return t.tab === tab; });
      if (!inTab.length) return;
      out.push("## " + pageLabel(tab), "");
      inTab.forEach(pushThread);
    });
    // Any threads on pages not covered above.
    threads.filter(function (t) { return !seen[t.tab]; }).forEach(function (t) {
      seen[t.tab] = true;
      out.push("## " + pageLabel(t.tab), "");
      threads.filter(function (x) { return x.tab === t.tab; }).forEach(pushThread);
    });
    return out.join("\n");
  }
  function downloadFile(filename, text, type) {
    var blob = new Blob([text], { type: type || "text/markdown" });
    var url = URL.createObjectURL(blob);
    var a = el("a"); a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 120);
  }

  /* ---- Modes (viewing / commenting) + export -------------------- */
  /* Viewing: links live, comments readable. Commenting: in-view links
     go inert so the whole surface is freely selectable, and a selection
     opens the composer. A reader switches modes from the top-bar
     control, or by starting a comment (the selection bubble flips it).  */
  var modeBtns = null, countEl = null;
  function mode() { return localStorage.getItem(LS.mode) || DEFAULT_MODE; }
  function applyMode() {
    var m = mode(), commenting = m === "comment";
    document.body.classList.toggle("cmt-mode-comment", commenting);
    document.body.classList.toggle("cmt-mode-view", !commenting);
    document.body.classList.toggle("cmt-quiet-view", !VIEW_MARKS);
    document.body.classList.toggle("cmt-pins-on", PINS);
    var root = viewRoot();
    if (root) root.classList.toggle("cmt-commenting", commenting);
    if (modeBtns) modeBtns.forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-mode") === m ? "true" : "false");
    });
    if (!commenting) { clearBubble(); clearPop(); }  // leaving comment mode dismisses UI
  }
  function setMode(m) { localStorage.setItem(LS.mode, m); applyMode(); }

  function updateCount() {
    var n = 0, tab = currentView();
    threads.forEach(function (t) { if (t.tab === tab) n += t.messages.length; });
    if (countEl) { countEl.textContent = n; countEl.style.display = n ? "" : "none"; }
  }
  function pickHost() {
    var sels = TOGGLE_HOST.split(",");
    for (var i = 0; i < sels.length; i++) {
      var e = document.querySelector(sels[i].trim());
      if (e) return e;
    }
    return null;
  }
  function buildTools() {
    var tools = el("div", "cmt-tools");
    var host = pickHost();
    // No header/footer to hang on: float the control bottom-right so the
    // layer is usable on a bare page with no chrome.
    if (!host) { tools.classList.add("cmt-tools--floating"); host = document.body; }

    var modes = el("div", "cmt-modes");
    modes.setAttribute("role", "group");
    modes.setAttribute("aria-label", "Comment mode");
    modeBtns = [];
    [["view", "Viewing"], ["comment", "Commenting"]].forEach(function (def) {
      var b = el("button", "cmt-mode-btn"); b.type = "button";
      b.setAttribute("data-mode", def[0]);
      b.setAttribute("title", def[0] === "comment"
        ? "Commenting: links are inert; select text to comment" + (PINS ? ", or click to drop a pin" : "")
        : "Viewing: links work normally");
      b.appendChild(el("span", "cmt-mode-label", def[1]));
      if (def[0] === "comment") { countEl = el("span", "cmt-mode-count", "0"); b.appendChild(countEl); }
      b.addEventListener("click", function () { setMode(def[0]); });
      modes.appendChild(b); modeBtns.push(b);
    });

    var exportBtn = el("button", "cmt-toggle cmt-export"); exportBtn.type = "button";
    exportBtn.setAttribute("title", "Download all comments as Markdown");
    var exIco = el("span", "cmt-toggle-ico"); exIco.setAttribute("aria-hidden", "true"); exIco.textContent = "⤓";
    exportBtn.appendChild(exIco); exportBtn.appendChild(el("span", "cmt-toggle-label", "Export"));
    exportBtn.addEventListener("click", function () { downloadFile(EXPORT_FILE, exportMarkdown()); });

    tools.appendChild(modes);
    tools.appendChild(exportBtn);
    host.appendChild(tools);
  }

  /* ---- Global listeners ----------------------------------------- */
  function onSelectionDone(e) {
    if (pop && pop.contains(e.target)) return;
    if (bubble && bubble.contains(e.target)) return;
    setTimeout(function () {
      var a = captureAnchor();
      if (a) showBubble(a); else clearBubble();
    }, 10);
  }

  function inViewLink(target) {
    var a = target.closest && target.closest("a");
    return (a && a.closest(VIEW_SEL) && !a.closest(SKIP_SEL)) ? a : null;
  }

  /* A drag that starts on a link is a link drag, not a text selection,
     and cancelling dragstart doesn't change that in Chrome. So in
     commenting mode the href is dropped for the length of the press:
     without it the anchor is plain text and selects normally. It goes
     back right after the click dispatches. */
  var heldLink = null, heldHref = null;
  function restoreLink() {
    if (heldLink && heldHref !== null) heldLink.setAttribute("href", heldHref);
    heldLink = null; heldHref = null;
  }

  // Where the press started, to tell a click (pin) from a drag (select).
  var downX = 0, downY = 0, pinTimer = null;
  function cancelPin() { if (pinTimer) { clearTimeout(pinTimer); pinTimer = null; } }

  function refresh() {
    cancelPin(); clearBubble(); clearPop();
    renderAll(); applyMode();
    observeRoot();
  }

  var observed = null, ro = null;
  function observeRoot() {
    if (!window.ResizeObserver) return;
    var root = viewRoot();
    if (root === observed) return;
    if (!ro) ro = new ResizeObserver(function () { positionPins(); });
    if (observed) ro.unobserve(observed);
    observed = root; if (root) ro.observe(root);
  }

  function init() {
    buildTools();
    Store.load().then(function () {
      renderAll();
      applyMode();
      observeRoot();
    });

    // Public hook for hosts that change the page in ways the layer can't
    // see: window.CommentLayer.refresh() re-reads the view.
    CFG.refresh = refresh;
    window.CommentLayer = CFG;

    // Client-side navigation: re-render so counts, highlights and pins
    // follow the page. Covers hash routing and history-API routers.
    if (SPA) {
      var later = function () { setTimeout(refresh, 0); };
      window.addEventListener("hashchange", later);
      window.addEventListener("popstate", later);
      ["pushState", "replaceState"].forEach(function (fn) {
        var orig = history[fn];
        history[fn] = function () {
          var before = location.href, out = orig.apply(this, arguments);
          if (location.href !== before) later();
          return out;
        };
      });
    }

    window.addEventListener("resize", positionPins);
    // Images and fonts that load late shift the elements pins sit on.
    document.addEventListener("load", positionPins, true);

    document.addEventListener("mousedown", function (e) {
      downX = e.clientX; downY = e.clientY;
      if (e.detail > 1) cancelPin();
      if (e.button !== 0 || mode() !== "comment") return;
      var a = inViewLink(e.target);
      if (a && a.hasAttribute("href")) { heldLink = a; heldHref = a.getAttribute("href"); a.removeAttribute("href"); }
    }, true);
    document.addEventListener("mouseup", function () {
      if (heldLink) setTimeout(restoreLink, 0);
    }, true);
    document.addEventListener("mouseup", onSelectionDone);

    document.addEventListener("click", function (e) {
      // Reading a comment always wins over following a link.
      var mk = e.target.closest && e.target.closest("mark.cmt-hl");
      if (mk) { e.preventDefault(); cancelPin(); openThread(mk.getAttribute("data-cid")); return; }
      var commenting = mode() === "comment";
      // In commenting mode, in-view links are inert so the surface stays
      // freely selectable (and pinnable) without navigating away.
      if (commenting && inViewLink(e.target)) e.preventDefault();

      // A click outside open UI only dismisses it; it doesn't also pin.
      if (pop && pop.contains(e.target)) return;
      if (bubble && bubble.contains(e.target)) return;
      var dismissed = !!(pop || bubble);
      clearPop(); clearBubble();
      if (dismissed) return;

      if (e.detail > 1) { cancelPin(); return; }
      if (!commenting || !PINS || e.button !== 0) return;
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
      var sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      var a = capturePin(e);
      if (!a) return;
      // Wait out a possible double-click (which selects a word instead).
      cancelPin();
      pinTimer = setTimeout(function () {
        pinTimer = null;
        var s = window.getSelection();
        if (s && !s.isCollapsed) return;
        openComposer(a);
      }, 250);
    });

    // Belt and braces for browsers that do honor a cancelled dragstart.
    document.addEventListener("dragstart", function (e) {
      if (inViewLink(e.target)) e.preventDefault();
    });

    document.addEventListener("keydown", function (e) { if (e.key === "Escape") { cancelPin(); clearPop(); clearBubble(); } });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
