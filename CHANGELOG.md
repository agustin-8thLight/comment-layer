# Changelog

## 2026-10-15

Folded in fixes from running the layer on a Next.js review site, and added pins.

**Added**

- **Pins.** In commenting mode, a click (no drag) drops a pin comment on that
  spot. Pins anchor to the clicked element and follow it through reflow. On by
  default; `pins: false` turns them off.
- **`showInView: false`.** Viewing mode shows the page untouched: no highlight
  tint, no pins, clicks pass through.
- **`window.CommentLayer.refresh()`** for hosts that swap content without a URL
  change.
- **Optional password gate** in the Worker (`SITE_PASSWORD` secret), for
  reviewers outside your identity provider.

**Changed**

- **`spa: true` follows history-API routers** (`pushState`, `replaceState`,
  `popstate`), not only `hashchange`. Next `<Link>` navigation no longer leaves
  highlights stuck on the first page.
- **Link text selects in commenting mode in Chrome.** The `href` is dropped for
  the length of the press; cancelling `dragstart` alone didn't work.
- **Default `skipSelector` skips only the page-level header** (`body > header`,
  `[role=banner]`), so page intros inside `<main>` are commentable.
- **The Worker adds new columns itself** on first request. Upgrading is a
  redeploy.
- **`wrangler.jsonc` sets `run_worker_first: true`** so the gate covers pages.

## 2026-07-08

- Viewing / commenting modes; link text commentable.
- Initial release: select-to-comment, anchored highlights, local or D1-backed
  storage, Markdown export.
