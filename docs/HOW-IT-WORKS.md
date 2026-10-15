# How it works

The internals, for anyone extending the library or debugging an anchor that
won't stick. If you just want to install it, read
[INTEGRATION.md](INTEGRATION.md).

## The shape of the data

Everything is threads and messages.

```js
thread = {
  id,           // "t-..." unique
  tab,          // page id the thread lives on (currentView)
  exact,        // the quoted text (pins: a label of the clicked element)
  prefix,       // ~40 chars before the quote  } context for re-anchoring
  suffix,       // ~40 chars after the quote    } (both empty for pins)
  pin,          // pins only: { path, x, y, rx, ry }, see Pins below
  messages: [ {
    id,         // "m-..."
    name,       // author, honor-system
    body,       // the comment text
    ts,         // Date.now() when posted
    owner       // random per-browser token; gates delete
  } ]
}
```

A comment is a thread with one message; replies append messages. Delete the last
message and the thread is removed.

## Anchoring: why comments survive edits

The hard part of any commenting layer is: where does a comment point, and does
that survive the page changing? Two approaches fail:

- **DOM path / XPath** breaks the moment the markup is restructured.
- **Absolute character offset** breaks the moment anything above it is edited.

This layer anchors to the **text and its neighborhood** instead. Three steps:

### 1. Build a flat text map

`textMap(root)` walks every text node inside the view (a `TreeWalker`), skipping
nodes inside `skipSelector`, and concatenates them into one string. It keeps a
`map` of `{ node, start }` so any index into that string can be traced back to
the DOM text node and offset it came from.

### 2. Capture (on comment)

When you select and comment, `captureAnchor` converts the selection's start and
end into indices in the flat string, then stores:

- `exact` — the selected substring,
- `prefix` — up to `context` (40) chars immediately before,
- `suffix` — up to `context` chars immediately after.

No node references, no offsets into the whole document. Just text.

### 3. Re-anchor (on load)

`renderRoot` rebuilds the text map for the current page and, for each thread,
runs `indexOf` to find **every** occurrence of `exact`. If the quote is unique,
done. If it appears more than once, each occurrence is scored by how much of the
stored `prefix`/`suffix` still matches the text actually surrounding it
(`commonSuffix` on the left, `commonPrefix` on the right). Highest score wins.
Then `wrapPortion` splits the relevant text nodes and wraps the matched range in
`<mark class="cmt-hl" data-cid="...">`.

**Consequences worth knowing:**

- Edit text *around* a quote: the anchor holds (the exact string is still there;
  worst case the context score drops but the match is still found).
- Edit the *quoted words themselves*: `indexOf` finds nothing, the highlight is
  dropped. The comment is not deleted — it still appears in the export — it just
  has nowhere to attach visually.
- Duplicate passages are disambiguated by context, not perfectly. Two identical
  sentences with identical surroundings will both score the same; the first wins.
- Highlights are re-derived from scratch on every render (`unwrap` then re-wrap),
  so the DOM never accumulates stale marks.

## Pins

A pin is a thread with a `pin` field. Text anchoring skips it (its `exact` is
only a label), and it renders as a button in one absolutely positioned layer on
`<body>`, outside the view, so it never enters the text map or shifts layout.

- **Capture.** `capturePin` takes the click target and records `path` (a chain
  of `tag:nth-of-type(n)` from the view root, cut short at the nearest element
  with a non-`cmt-` id), `x`/`y` (the click as fractions of the target's box) and
  `rx`/`ry` (the click as fractions of the view root's box).
- **Render.** `pinPoint` resolves the path with `root.querySelector(":scope > …")`
  and turns the fractions back into page coordinates. If the path no longer
  resolves it uses `rx`/`ry` on the root. A target with no box (hidden) hides
  its pin.
- **Keeping up with layout.** `positionPins` reruns on window resize, on a
  `ResizeObserver` of the view root, and on any `load` event in the document
  (late images and fonts), so pins track reflow without polling.
- **Click vs. drag.** The `click` handler drops a pin only in commenting mode,
  when the pointer moved less than 4px since `mousedown`, the selection is
  collapsed, and no popover or bubble was open (that click just dismisses it).
  It waits 250ms and gives up if a double-click or selection happened in
  between.

## Storage adapter

`Store` has one interface (`load`, `addThread`, `addMessage`, `deleteMessage`)
and two implementations chosen by whether `backend` is set:

- **Local (`backend: null`).** Threads are a JSON blob in `localStorage` under
  `cmt-data-<docId>`. Everything is synchronous but wrapped in resolved Promises
  so the calling code is identical to backend mode.
- **Backend (`backend: "/api"`).** The same operations become `fetch` calls to
  the Worker, which persists to D1. The methods return the server's copy of the
  saved record.

Because both return Promises with the same shapes, nothing else in the code
knows or cares which mode is active. That's the whole reason adding shared
comments is a one-line config change.

## Identity and permissions

- **Name** is stored in `localStorage` (`cmt-name-<docId>`) and pre-filled next
  time. Purely a convenience; anyone can type any name.
- **Owner** is a random token minted once per browser (`cmt-owner`) and attached
  to every message. The delete button only renders on messages whose `owner`
  matches this browser, and the backend's delete query also checks `owner`, so a
  reader can only remove their own comments. This is light moderation, not
  security.

## Modes and links

Two modes, tracked by a body class (`cmt-mode-view` / `cmt-mode-comment`) and
persisted per `docId`.

- **Viewing** is the default: the page behaves normally, links live.
- **Commenting** makes in-view links inert. There's no `pointer-events: none`
  trick (that would also block text selection). Instead the document click
  handler, when in commenting mode, calls `preventDefault()` on clicks that land
  on an `a[href]` inside the view. The link's text stays fully selectable; only
  navigation is suppressed. The view root also gets a `cmt-commenting` class so
  CSS can show a text caret over those links.

Because `<a>` is not in `skipSelector`, link text is part of the text map, so a
comment can anchor to it and a highlight can be wrapped *inside* an anchor.
Clicking a highlight is checked before the link-inert rule, so reading a comment
always wins over following the link.

A drag that starts on a link is a link drag in Chrome even if `dragstart` is
cancelled, so link text would not select. In commenting mode a capture-phase
`mousedown` removes the link's `href` for the length of the press (an anchor
without `href` is plain text), and a capture-phase `mouseup` restores it on the
next tick, after the click has dispatched. The click itself is cancelled, which
framework links (Next's `<Link>` checks `defaultPrevented`) respect.

With `showInView: false` the body gets `cmt-quiet-view`, and in viewing mode
highlights lose their tint and `pointer-events`, and pins hide. The page reads
as the design itself.

## Client-side navigation

With `spa: true`, `history.pushState` and `replaceState` are wrapped so that a
call which changes the URL schedules `refresh()`, as do `hashchange` and
`popstate`. `refresh()` closes open UI, re-renders highlights and pins, reapplies
the mode, and re-observes the view root (a router may have replaced it). It is
exposed as `window.CommentLayer.refresh` for hosts that change content without
touching the URL.

Entering commenting mode: the top-bar segmented control sets it directly, and
the selection **Comment** bubble sets it as a side effect (selecting in viewing
mode, then clicking the bubble, flips the mode and opens the composer).

## Rendering and the control

- On `mouseup`, if there's a non-collapsed selection inside the view,
  `showBubble` places the floating **Comment** bubble above it. Clicking opens
  the composer popover (flipping into commenting mode first if needed); saving
  creates the thread and immediately reopens it as a thread popover.
- Clicking an existing highlight opens its thread. Popovers are positioned under
  the highlight and nudged left if they'd overflow the viewport.
- `buildTools` injects the mode switch + export control into the first element
  matching `toggleHost`; if none matches it creates a floating control fixed
  bottom-right, so the layer is usable even on a page with no header or footer.
- The per-page count on the Commenting segment reflects only threads whose `tab`
  is the current page, and hides itself at zero.

## Export

`exportMarkdown` (client) and the Worker's `/api/export` (server) produce the
same document: a heading, a per-page section (using `pages` labels and order if
provided, else first-seen page order), and under each page a block per thread
showing the quoted text and its messages. The client version also prefixes each
quote with the nearest preceding `h1`/`h2`, which the server version can't
because it has no DOM. The format is deliberately plain so it pastes cleanly into
Claude for triage.

## Extending it

- **Change what's commentable:** `viewSelector` / `skipSelector` (config, no code
  change).
- **Change the anchor robustness:** `context` (config). Bigger context helps with
  repeated passages at the cost of record size.
- **Add fields to a comment** (e.g. a category): extend the `message` object in
  `openComposer`, the `messages` table in `schema.sql`, and the INSERT/SELECT in
  `worker.js`. Keep the local and backend paths in sync. If existing databases
  need the column, add it in `ensureSchema` the way `pin` is, so a Worker
  redeploy is the whole upgrade.
- **Swap the store** (e.g. a different backend): reimplement the four `Store`
  methods. Nothing else should need to change.
