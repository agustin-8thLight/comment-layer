# Integration guide

Everything you need to add the comment layer to a page and configure it. If you
want to understand the internals before changing the library, read
[HOW-IT-WORKS.md](HOW-IT-WORKS.md) instead.

## Install

1. Copy `comment-layer.css` and `comment-layer.js` into your project.
2. Set `window.CommentLayer` **before** the script loads.
3. Link the CSS and the JS.

```html
<head>
  <script>
    window.CommentLayer = { docId: "my-doc", viewSelector: "main" };
  </script>
  <link rel="stylesheet" href="/comment-layer.css">
  <script src="/comment-layer.js" defer></script>
</head>
```

Order matters: the config global must exist when the script runs. Setting it in
the `<head>` before the `<script>` tag (as above) is the reliable way. `defer` is
fine; the script reads the global at init.

## Configuration reference

All fields are optional except that you'll almost always want `docId` and
`viewSelector`. Defaults in brackets.

| Field | Type | Default | What it does |
|-------|------|---------|--------------|
| `docId` | string | `"comments"` | Namespaces stored comments. Different docs must use different ids, or they'll share threads. Also the `doc` key in the backend and the default filename/heading base. |
| `viewSelector` | string | `"main, #main, .content, article, #content, body"` | Where selectable text lives. **Priority-ordered**: the first selector that matches an element wins. Only text inside this element is commentable. |
| `backend` | string \| null | `null` | `null` (or omitted) = local-only (localStorage). Set to the Worker's API base (usually `"/api"`) to share comments across visitors. |
| `skipSelector` | string | see below | Elements whose text is excluded from selection (nav, buttons, code, etc.). Links are **not** skipped — see Modes. |
| `context` | number | `40` | Characters of surrounding text stored on each side of a quote, used to re-anchor. Larger = more robust matching, bigger records. |
| `pages` | array | `[]` | Optional `[id, label]` pairs. Sets the section order and labels in the Markdown export. `id` is the page's `currentView` (pathname, extensionless; `"index"` for root). |
| `title` | string | `"<docId> comments"` | Heading at the top of the exported Markdown. |
| `exportFilename` | string | `"<docId>-comments.md"` | Filename for the browser Export download. |
| `toggleHost` | string | `".cmt-host, .footer-tools, .site-footer, .header-inner, .site-header, header, footer"` | Where the mode + export control is injected. First match wins. **If nothing matches, the control floats bottom-right.** |
| `spa` | boolean | `false` | Set `true` when pages change without a full reload: hash routing, or a history-API router (Next `<Link>`, React Router). The layer re-renders highlights, pins and counts on `hashchange`, `popstate`, `history.pushState` and `history.replaceState`. |
| `pins` | boolean | `true` | In commenting mode, a click (no drag) drops a pin comment on that spot. `false` turns pins off; text selection is unaffected. |
| `showInView` | boolean | `true` | `false` makes viewing mode show the page untouched: no highlight tint, no pins, clicks pass through to links underneath. Everything reappears in commenting mode. Good for design reviews where the page itself is under review. |
| `defaultMode` | string | `"view"` | Mode a reader lands in: `"view"` (links live) or `"comment"` (in-view links inert, select to annotate). See Modes. |

### Default `skipSelector`

```
nav, body > header, [role=banner], footer, aside, button, code, pre,
script, style, input, textarea, select, [contenteditable], .cmt-pop,
.cmt-bubble, .cmt-tools, .cmt-pin, [data-cmt-skip]
```

Only the page-level `<header>` is skipped. A `<header>` inside the view is
usually a page or section intro, which reviewers want to quote. If your site
masthead is nested deeper (common in framework layouts), keep it outside your
`viewSelector` element, or give it `data-cmt-skip`.

`<a>` is deliberately absent: link text is commentable (see Modes). To exclude
something specific without rewriting the whole list, add the `data-cmt-skip`
attribute to that element — it's already in the default. To make something
*inside* a skipped region commentable, override `skipSelector` with your own list.

## Modes: viewing vs commenting

The layer has two modes, like Google Docs' Viewing / Suggesting split, and the
control in your `toggleHost` switches between them.

- **Viewing** (default). Links work normally, comments are visible and clickable
  to read. This is how most people arrive.
- **Commenting.** Links *inside the view* go inert (a click won't navigate) so
  the whole surface, link text included, is clean to select. Selecting text
  opens the composer. A plain click drops a pin (see below). Site chrome outside
  the view (nav, header) keeps working, so multi-page navigation is unaffected.

A reader enters commenting mode two ways:

1. **The top-bar control** — an explicit Viewing / Commenting switch.
2. **Starting a comment** — selecting text in viewing mode shows the *Comment*
   bubble; clicking it flips into commenting mode and opens the composer. So
   links keep working until the reader actually decides to annotate.

The mode is remembered per `docId` in localStorage. Set `defaultMode: "comment"`
to open straight into commenting (e.g. a doc whose only purpose is review).

**Behaviors worth knowing:**

- Clicking a highlight opens its thread, even in viewing mode and even if the
  highlight sits on a link: reading the comment wins over following the link.
  With `showInView: false`, highlights are click-through in viewing mode, so
  the link wins there instead.
- Browsers treat a drag that starts on a link as dragging the link, not
  selecting its text. In commenting mode the layer removes the link's `href`
  for the length of the press and puts it back right after, so link text
  selects like any other text. Site-chrome links are untouched.

## Pins

In commenting mode, click anywhere in the view without dragging and a composer
opens with a provisional pin on the spot. Save it and the pin becomes a
numbered marker; click it to read or reply.

- **Click drops a pin, drag selects text, double-click selects a word.** The
  layer waits a beat after a click so a double-click never leaves a stray pin.
- **A click while a popover or the Comment bubble is open only closes it.**
- **Anchoring.** A pin stores a structural path from the view root to the
  element you clicked, plus where on that element you clicked (as fractions of
  its box). It follows the element through resizes, reflow and late-loading
  images. If the markup changes so the path no longer resolves, it falls back to
  the same relative spot on the view root. Pins are less durable than text
  anchors across big markup rewrites; that's the tradeoff for commenting on
  things that aren't text.
- **Export** lists pins as `pin on: “<label>”`, where the label is the clicked
  element's alt text, aria-label, or text.
- Pins count toward the Commenting badge. Turn them off with `pins: false`.

## Single-page apps and framework routers

Set `spa: true`. The layer then repaints on `hashchange`, `popstate`, and any
`history.pushState` / `replaceState` that changes the URL, which covers Next.js
`<Link>`, React Router and most client routers. The page id is the pathname, so
query strings and hashes don't create separate pages.

If your app changes the page some other way (content swapped in place, no URL
change), call the refresh hook yourself after it renders:

```js
window.CommentLayer.refresh();
```

In a React app, load the layer once in the root layout (not per page), behind
a flag so it ships only in review builds.

## Theming

The CSS reads design tokens with fallbacks, e.g. `var(--accent, #2563eb)`. Two
ways to style it:

- **Do nothing.** The fallbacks produce a clean neutral look with a blue accent.
- **Define the tokens** on `:root` (or any ancestor of the page). The layer picks
  them up. The ones worth setting:

  ```css
  :root {
    --accent: #5b8def;      /* highlight, focus ring, count badge */
    --surface: #fff;        /* popover background */
    --bg: #fff;             /* field background */
    --bg-alt: #f2f5fb;      /* quote block */
    --text: #1c2430;
    --text-strong: #0b1220;
    --text-soft: #4a5568;
    --text-faint: #8a94a6;
    --line: #e7ebf2;        /* dividers */
    --line-strong: #c9d2e0; /* borders */
    --font-body: "Inter", system-ui, sans-serif;
    --font-mono: ui-monospace, monospace;
    --radius: 7px;
    --shadow: 0 12px 34px rgba(20,33,61,.16);
  }
  ```

  If your design system already defines some of these, the layer inherits them
  automatically. `examples/02-multi-page/theme.css` shows this end to end.

  Two tokens are namespaced to avoid clashes: `--cmt-fast` (transition duration,
  default `140ms`) and `--cmt-ease` (easing). Set those if the defaults fight
  your motion system.

## Common questions

**Nothing is commentable.** Your `viewSelector` doesn't match, or the text is
inside a skipped element. Check that the selector resolves and that the content
isn't wrapped in `nav`/`aside`/`code` etc.

**The control shows up in the wrong place / floats when I wanted it inline.**
Set `toggleHost` to a selector that exists on your page (e.g. `".my-toolbar"`).
The library appends the control as the last child of the first match.

**Comments vanished after I moved the site.** In local-only mode they're tied to
the exact origin + `docId` in one browser. A different origin or a changed
`docId` is a different namespace. This is also why local comments don't migrate
when you turn on the backend.

**Highlights don't reappear after I edited the copy.** If you changed the exact
words that were quoted, the anchor is gone (by design). Editing around the quote
is safe. See HOW-IT-WORKS.md.

**Multiple docs on one backend.** Give each a distinct `docId`. Every row carries
it, so one D1 database can hold many docs.

**Content-Security-Policy.** The layer uses inline-created elements and
`fetch` (backend mode only). No inline event handlers, no `eval`. If your CSP is
strict, allow `connect-src` to the Worker origin in backend mode.
