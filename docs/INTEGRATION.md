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
| `skipSelector` | string | see below | Elements whose text is excluded from selection (nav, buttons, code, etc.). |
| `context` | number | `40` | Characters of surrounding text stored on each side of a quote, used to re-anchor. Larger = more robust matching, bigger records. |
| `pages` | array | `[]` | Optional `[id, label]` pairs. Sets the section order and labels in the Markdown export. `id` is the page's `currentView` (pathname, extensionless; `"index"` for root). |
| `title` | string | `"<docId> comments"` | Heading at the top of the exported Markdown. |
| `exportFilename` | string | `"<docId>-comments.md"` | Filename for the browser Export download. |
| `toggleHost` | string | `".cmt-host, .footer-tools, .site-footer, .header-inner, .site-header, header, footer"` | Where the toggle/export control is injected. First match wins. **If nothing matches, the control floats bottom-right.** |
| `spa` | boolean | `false` | Set `true` for single-page hubs that swap content on `hashchange`; the layer re-renders highlights and counts when the hash changes. |

### Default `skipSelector`

```
nav, header, footer, aside, button, a, code, pre, script, style,
input, textarea, select, [contenteditable], .cmt-pop, .cmt-bubble,
.cmt-tools, [data-cmt-skip]
```

To exclude something specific without rewriting the whole list, add the
`data-cmt-skip` attribute to that element — it's already in the default. To make
something *inside* a skipped region commentable, you'll need to override
`skipSelector` with your own list.

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
