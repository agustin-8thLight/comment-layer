# Examples

Both examples run locally with no backend and no build step.

## Run them

Either open the HTML file directly, or serve the repo root over http (some
browsers are stricter about `file://`, and http matches how you'll actually
deploy):

```bash
# from the repo root
python3 -m http.server 8000
# then visit:
#   http://localhost:8000/examples/01-local-only/
#   http://localhost:8000/examples/02-multi-page/
```

## What each one shows

### `01-local-only/` — the smallest possible setup
A single bare page, no design system, no backend. Demonstrates the zero-config
path: set three fields, include two files, done. The toggle control has no header
to attach to, so it floats bottom-right. Comments are saved in your browser.

### `02-multi-page/` — theme adoption + multi-page + export grouping
Two pages sharing one config file (`comments-config.js`). Shows three things:

- **Theme adoption.** `theme.css` defines `--accent`, fonts, and surfaces. The
  layer reads those tokens and matches the site. Change `--accent` and the
  highlights follow.
- **Per-page anchoring.** A comment made on the Overview page stays there; the
  Anchoring page has its own. Each thread records its page.
- **Export grouping.** The `pages` list gives each page a label and fixes the
  section order in the exported Markdown.

Still local-only. To make either one a shared team review, deploy the Worker in
[`../backend`](../backend/) and set `backend: "/api"` in the config.
