# Next research workflow features

This phase focuses on usability around existing research workflows rather than expanding storage
capabilities or network scope. Cloud sync, collaboration, alerts, automatic notebook AI, arbitrary
web articles, destructive schema migrations, and lossy exports remain out of scope.

## Priorities

1. Search note titles and bodies offline while preserving bounded keyset paging and existing note
   actions.
2. Refresh metadata for all references on the current notebook page using explicit user action,
   bounded concurrency, cancellation, and existing stale/error preservation.
3. Show reference and note counts beside notebook titles without loading note bodies or references.
4. Add a version consistency check so application and package release numbers cannot drift.
5. Verify native Debian and Nix package builds when suitable builders are available.

## Acceptance criteria

- Searching note bodies does not fetch network data, alter notes, load full result pages into the
  TUI, or become an application-defined note cap. Implemented with case-insensitive SQLite
  title/body matching and a 50-note summary page default; opening a match loads only that note.
- Filters survive paging, clear intentionally, and report storage errors without hiding committed
  notes. Implemented: `/` keeps the current query while paging and an empty query clears it.
- Page-level metadata refresh is explicit, request-owned, cancellable, and preserves prior snapshots
  on failure; notes are never modified. Implemented with uppercase `F`, sequential visible-page
  requests, progress counts, Esc cancellation, and per-reference failure markers.
- List counts come from bounded aggregate queries and remain consistent after changes. Implemented:
  the library shows references/notes per notebook, recomputed on reload.
- Package version validation fails builds or checks when release versions diverge. Implemented:
  `packaging/version_test.ts` compares AUR/Debian/Nix/RPM manifests to `deno.json`.
- Documentation names unavailable native verification separately from completed local checks.
