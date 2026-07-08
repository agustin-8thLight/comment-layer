/* Shared comment-layer config for the multi-page example.
   Loaded by every page BEFORE comment-layer.js, so all pages agree on
   the docId, the page labels used in the export, and where the toggle
   control lives.

   Still local-only (backend: null). To share across a team, deploy the
   Worker in ../../backend and change one line: backend: "/api". */
window.CommentLayer = {
  docId: "example-multipage",
  backend: null,
  viewSelector: "main",
  toggleHost: ".site-header .bar",   // inject the control into the header
  title: "Field notes — review comments",
  exportFilename: "field-notes-comments.md",

  // Optional. Maps each page id (the pathname, extensionless) to a label
  // and fixes the order sections appear in the exported Markdown. Omit it
  // and the export falls back to raw ids in first-seen order.
  pages: [
    ["index",    "Overview"],
    ["chapter-2", "Chapter 2 — Anchoring"]
  ]
};
