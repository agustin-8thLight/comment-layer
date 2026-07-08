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
  exact,        // the quoted text
  prefix,       // ~40 chars before the quote  } context for re-anchoring
  suffix,       // ~40 chars after the quote    }
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

## Rendering and the control

- On `mouseup`, if there's a non-collapsed selection inside the view,
  `showBubble` places the floating **Comment** bubble above it. Clicking opens
  the composer popover; saving creates the thread and immediately reopens it as a
  thread popover.
- Clicking an existing highlight opens its thread. Popovers are positioned under
  the highlight and nudged left if they'd overflow the viewport.
- `buildToggle` injects the show/hide + export control into the first element
  matching `toggleHost`; if none matches it creates a floating control fixed
  bottom-right, so the layer is usable even on a page with no header or footer.
- The per-page count next to the toggle reflects only threads whose `tab` is the
  current page.

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
  `worker.js`. Keep the local and backend paths in sync.
- **Swap the store** (e.g. a different backend): reimplement the four `Store`
  methods. Nothing else should need to change.
