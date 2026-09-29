# Saved searches and research notebooks

Status: implementation started in
[roadmap Phase 6](roadmap.md#phase-6-saved-searches-and-research-notebooks). The
[research store](../src/research/store.ts) implements versioned SQLite saved searches and notebooks.
[Saved-search UI](../src/ui/saved_searches.ts) supports management and replay through the
application. [Notebook UI](../src/ui/notebooks.ts) supports CRUD, paginated membership, offline
reference entry, cancellable loaded-result additions, and existing detail/comparison workflows.
Schema v3 adds repository-level Markdown note CRUD, paginated citations, revision checks, and
same-notebook membership constraints. The notebook UI counts notes on deletion and requires explicit
confirmation before unlinking citations. [Notes UI](../src/ui/notes.ts) now integrates `micro` with
private drafts, explicit save/discard/continue, revision conflicts, and restart recovery.
[Citation UI](../src/ui/citations.ts) supports offline additions and confirmed removals with
independent filtered, paginated lists. Metadata snapshots and import/export remain planned.

## Goals

Add two local-first research features:

- Saved searches preserve named queries and filters for later replay.
- Notebooks organize notes and references to any number of distinct pieces of legislation, across
  congresses and supported legislation types.

"Unlimited" means no application-defined limit on notebook references, notes, or notebooks. Storage,
memory, and filesystem limits still apply. Large notebooks must remain usable without loading every
reference or fetching every legislative record at once. API page limits and AI context limits must
not become notebook membership limits.

These are research notebooks, not executable Jupyter notebooks. Initial support does not include
code execution, cloud synchronization, collaborative editing, background alerts, or automatic
whole-notebook AI analysis.

## Existing foundations

- [Domain types](../src/types.ts) provide `BillRef`, record completeness, and text truncation
  metadata.
- [Congress.gov adapter](../src/api/congress.ts) supports search coverage and continuation, direct
  references, historical membership, and explicit partial-result notices.
- [Application orchestration](../src/ui/app.ts) owns request cancellation, navigation, temporary
  two-bill comparison marks, and injectable ports for keyboard-flow tests.
- [Export serializers](../src/export.ts) and [design guidelines](design.md) establish provenance,
  source limitations, terminal sanitization, and local-data privacy requirements.

Notebook membership must be independent of comparison marks. Adding a third or later reference must
never fail because two bills are already marked for comparison. Returning to the main menu may clear
temporary marks, but must not clear persisted notebooks or searches.

## Saved searches

### Stored definition

Each saved search has a generated immutable ID, name, query, bill-type filter, congress selection,
creation timestamp, modification timestamp, and revision number. Names need not be unique; IDs
determine identity. Validate nonblank names and queries and supported filter values at the boundary.

Represent congress selection explicitly as either a fixed congress number or "current Congress."
Default to the fixed congress currently displayed when saving. A user must explicitly choose the
dynamic option. Resolve a dynamic congress when running the search, and show the resolved value.

Do not store pagination offsets, in-flight requests, API credentials, or result lists as part of the
definition. A saved search is a recipe, not a frozen set of matching bills.

### Workflows

1. Save the active query and filters from the results view, including an empty-results view.
2. Browse, filter by name, rename, duplicate, edit, or delete saved searches.
3. Run a saved search through the existing search command, starting at offset zero.
4. Continue partial results using the existing load-more action and coverage disclosures.
5. Add selected results or all currently loaded results to a notebook through an explicit action.

Running a search never adds or removes notebook references automatically. Label the batch action
"Add loaded results," not "Add all matches": unscanned records are not known matches. Later search
runs must not resume old offsets, because the upstream updated-date ordering can change.

Save an edited definition only on explicit confirmation; running a temporary variation does not
silently overwrite it. Deleting a saved search does not delete notes or references discovered
through that search. Offline browsing and editing work; executing a search still requires
Congress.gov access.

## Notebooks

### Workflows

1. Create a notebook with a title and optional description.
2. Add legislation from search results, a detail view, or a validated direct reference.
3. Browse and filter the notebook's paginated reference list across congresses and types.
4. Open a reference in the existing detail view, with a return path to the notebook's prior
   position.
5. Add Markdown notes that cite zero, one, or any number of references in the same notebook.
6. Select two notebook references for the existing comparison workflow without changing membership.
7. Export or back up the notebook, or delete it after confirmation.

The same legislation can belong to many notebooks. Repeatedly adding it to one notebook is
idempotent: report "already present" and retain its notes. Adding a reference directly must work
offline after local syntax validation; show it as unresolved until metadata can be fetched.

Removing a reference does not silently erase citations or notes. Refuse removal while notes cite it,
and offer explicit unlinking before removal. Deleting a notebook removes only that notebook's
membership and notes, never references belonging to another notebook. Cancelled note edits prompt to
discard changes; navigation must not silently lose an unsaved draft.

Implemented citation workflow: `c` on a saved note opens its citations; `a` opens the same-notebook
reference picker. Space/`m` toggles uncapped selections across pages/filters; Enter adds marked
references in batches of at most 250, or the highlighted reference when none are marked. Failed
batches remain selected; earlier commits are retained. Notebook explorer selections carry through
`n` into Notes and `c` into the selected note's citation picker for explicit review and application.
Only the comparison operation requires exactly two selections. `x` in the citation list asks for
removal confirmation. Both lists use 50-entry keyset pages with identity filtering, and keep their
own page/selection when switching between them. No API requests or whole-notebook loads are needed.
Writes use the displayed note revision; a conflict requires explicit reload with `r`. Returning
refreshes the saved note and citation count without changing its Markdown. New notes must be saved
first, and the unsaved draft's `c` shortcut remains Continue in micro.

From either citation list, `s` opens Congress.gov legislation search for new sources. This explicit
network action uses the existing query, type/Congress filters, coverage notices, and continuation.
In citation-search results and their details, `c` atomically adds notebook membership and the
citation using the captured note revision; failures roll back both. Duplicate citations are
idempotent. Searching or cancelling makes no research changes. Esc returns to the original citation
list or picker, and stale revisions require returning there to reload with `r`. Ordinary search
retains `c` for comparison; arbitrary web articles are not supported.

Contextual notebook/citation search uses independent, uncapped Space/`m` selections, retained across
queries and continuation for that destination. `b` adds marked notebook-search results; `c` cites
marked note-search results. Writes commit per reference and retain unprocessed marks on failure.
Leaving search for its notebook/citations clears marks without applying them. Detail actions still
operate on the open reference only. Comparison marks in ordinary search are separate.

Use contextual commands and menus rather than reassigning existing global shortcuts. Add library
entries to the main menu, actions to results and detail views, and context-specific help. Final key
bindings should be checked against search, find, comparison, and export controls before
implementation.

### Note editing with micro

Saved notes expose the common export menu with `w` from the list or reading view. Draft review uses
uppercase `W` so lowercase `w` still saves. Type, style, scope, and destination match comparison and
analysis exports. Entire-document snapshots contain the note body and all structured citations read
across keyset pages; current-view export follows the shared visible-screen behavior. Draft snapshots
are labelled unsaved and do not commit or discard the draft. Export return preserves the note list
selection and reader position. This is not a whole-notebook backup/import format.

The Notes list also offers `a` for AI-generated Markdown. The prompt screen discloses endpoint,
model, and that no notebook contents are included. Enter sends only the typed prompt; Esc cancels
in-flight work and late responses are ignored. Generated output is explicitly labelled as an AI
draft, stored in private recovery files, and opened for review without invoking Micro automatically.
`e` edits that file; `w` writes a uniquely named private Markdown snapshot to the configured export
directory and commits the notebook note. The export happens first; if the database commit then
fails, the written path is reported and the draft remains. These are two separate persistence
operations. Draft recovery retains this export-on-save behavior; saving creates no citations.

Use `micro` as the default integrated external editor for multiline Markdown notes, not as an
embedded library. It temporarily owns the terminal and returns to Billie when closed. Keep existing
Billie input fields for notebook titles, saved-search names, and search queries. Notebook membership
and structured citations remain managed by Billie; editing Markdown does not implicitly change them.

The editing workflow is:

1. Capture the note revision and write its draft to a private temporary directory, using a generated
   Markdown filename and owner-only permissions. Never edit the database file directly.
2. Suspend Billie keyboard reads and screen rendering, including asynchronous repaint callbacks.
   Restore normal terminal mode and leave the alternate screen before handing off the terminal.
3. Launch `micro` using `Deno.Command` with an argument array and inherited stdin, stdout, and
   stderr. Do not invoke a shell or interpolate note content into a command.
4. When the editor exits, read the saved draft file and restore Billie's terminal state and view in
   a `finally` path, including when launch, exit, or file reading fails.
5. Offer Save, Discard, or Continue editing. An editor exit is not proof that the user wants to
   commit the draft; only content saved to the file can be recovered from the editor.
6. Save through the research repository with the captured revision check. Preserve the draft on
   conflicts or persistence errors; remove temporary files only after a successful commit or an
   explicit discard. Retained recovery files must stay private and have their location disclosed.

The [terminal input layer](../src/ui/terminal.ts) yields editor-command keys before beginning
another read. Handoff checks that no read is pending (including the standalone-Escape timeout case),
exits raw/alternate-screen mode, and restores the TUI in `finally`. The app awaits the editor before
resuming its single input iterator. An input epoch discards buffered pre-editor keys, and both app
and terminal render guards suppress background repaints while Micro owns the terminal.

Treat `micro` as an explicit runtime dependency for note editing. Check its availability before
suspending the TUI and report installation guidance without losing the draft when it is missing. Add
`micro` alongside `typst` in the subprocess allowlist in [deno.json](../deno.json), and update
installer checks, distro dependencies, the Nix wrapper's executable path, and CI integration tests.
Do not broaden permission to arbitrary subprocesses just to support editing. Inject an editor port
for application tests; verify the real executable and terminal handoff in a separate PTY smoke test.

Implemented in [editor.ts](../src/research/editor.ts): availability is checked using
`micro -version` before suspension; launch uses inherited streams and no shell. Each private
recovery directory contains a Markdown draft, original note identity/revision, title, and isolated
Micro configuration. Micro autosave, backup, persistent undo, and cursor history are disabled.
Drafts remain after failure or app exit, and `R` in Notes recovers the latest draft for that
notebook. Saving or explicitly discarding removes it; save conflicts can instead be preserved as a
new uncited copy. The [PTY smoke test](../tests/micro_smoke.py) assigns its child a controlling
terminal, runs actual Micro across two sessions, and verifies saved text, recovery, and terminal
restoration.

### Identity and data model

Use generated UUIDs for searches, notebooks, and notes. Legislative identity uses structured fields,
never titles, URLs, or array positions. Initially support everything addressable by the current
`BillRef`: congress, normalized bill/resolution type, and number, namespaced by source and record
kind. For example, Congress.gov bill HR 1 in Congress 118 differs from HR 1 in Congress 119.

Allow a future record-kind discriminator for amendments and other legislative resources, but do not
pretend the current bill adapter can retrieve them. Adding an adapter and validating its identifier
is a separate extension; unknown record kinds must be rejected without data loss on import.

Recommended logical entities:

| Entity                | Main fields and constraints                                                           |
| --------------------- | ------------------------------------------------------------------------------------- |
| Saved search          | ID, name, query, type filter, congress mode/value, timestamps, revision               |
| Notebook              | ID, title, description, timestamps, revision                                          |
| Legislation reference | ID, source, kind, congress, type, number; unique canonical identity                   |
| Notebook reference    | Notebook ID, reference ID, added time; unique membership pair                         |
| Note                  | ID, notebook ID, Markdown body, timestamps, revision                                  |
| Note citation         | Note ID, notebook ID, reference ID; unique citation pair and same-notebook membership |
| Reference metadata    | Reference ID, title, source URL, source update date, retrieval time, limitations      |

Notes and citations are separate entities so neither a note nor a notebook needs a fixed-length
reference array. Use foreign keys and transactions to enforce notebook membership for citations.
User notes remain distinct from authoritative metadata and explicitly saved generated analysis.

## Persistence

Use a local SQLite database under `$XDG_DATA_HOME/billie/research.sqlite3`, falling back to
`$HOME/.local/share/billie/research.sqlite3`. This is durable user-authored data, not a disposable
cache and not part of the API-key configuration file. Resolve paths through a tested helper and
report an actionable error when no suitable data directory can be resolved.

SQLite is recommended over a single growing JSON file because it supports indexed pagination, atomic
multi-entity writes, uniqueness, and concurrent access without rewriting the whole library. Before
choosing a driver, validate compatibility with Deno 2.9.4, `deno compile`, CI, and the existing
Linux packages. Prefer a maintained driver; do not implement a custom database. Any new native
dependency or runtime permission must be documented and reflected in packaging and build tasks.

Initial implementation uses Deno 2.9.4's built-in `node:sqlite` adapter. A local compiled consumer
successfully created, closed, and reopened saved-search storage with only read/write permissions; no
additional FFI permission or external SQLite library was required. Fresh package builds and hosted
CI validation remain pending. Schema v2 adds notebooks, canonical legislative identities, and
many-to-many membership; schema v3 adds Markdown notes and structured citations. Upgrades from v1 or
v2 first create a private SQLite `VACUUM INTO` snapshot, including committed WAL data, then migrates
transactionally. Failed migration rolls back and reports the backup path. Snapshots are retained for
manual recovery; see the [README](../README.md#research-notebooks). Fresh databases initialize
directly through all schema steps without an unnecessary empty backup.

Note bodies are preserved verbatim and loaded individually, not with list pages. Note and citation
lists use keyset pagination; citation changes accept at most 250 additions/removals per transaction,
not a per-note citation limit. Note creation can include an initial citation batch atomically, while
later body edits leave citations unchanged. Composite foreign keys enforce both note ownership and
same-notebook membership. Note/citation writes advance the notebook revision so deletion previews
cannot erase intervening work. Reference removal is blocked while cited unless explicitly confirmed
unlinking is requested; unlinking and removal commit together, advancing affected note revisions
without rewriting their Markdown. Notebook deletion cascades only to its own notes and memberships.

- Create the directory with owner-only access and restrict database, backup, journal, and WAL files.
- Version the schema and apply migrations transactionally, backing up before destructive migrations.
- Refuse unsupported newer schemas without resetting or overwriting the database.
- Use parameterized queries, foreign keys, bounded lock waits, and explicit transaction boundaries.
- Use revision checks for edits from multiple app instances; offer reload on conflicts instead of
  silently overwriting newer work. Serialize writes through the repository boundary within an
  instance.
- Acknowledge saves only after commit. Disk-full, permission, corruption, and migration errors must
  preserve the previous committed data and keep the user's unsaved draft recoverable in the UI.
- Use a database-supported backup procedure; do not copy only the main file while WAL writes are
  active.

Notebook and note deletion must confirm the affected counts. Whole-notebook deletion should be an
atomic operation. Research data must survive normal upgrades, cache clearing, and configuration
edits.

## Scale and request behavior

Index canonical identities, notebook membership, and note ownership. Use keyset pagination with a
stable tie-breaker such as ID for reference lists and notes; a page size is a rendering/batch
budget, not a membership cap. Query counts separately. Do not scan or deserialize all references
simply to open a notebook, edit its title, or add one item.

Load metadata only for the visible page or explicitly selected references. Opening a notebook must
not trigger one API call per entry. Use bounded fetch concurrency, deduplicate requests, and retain
request-ownership guards so late responses cannot reopen a closed notebook or restore deleted
entries.

Batch additions validate and deduplicate inputs, report added and already-present counts, and use
bounded transactions for large imports. If cancellation occurs between batches, retain committed
batches and report their counts; never claim the entire operation was rolled back. Ordinary single
note and membership edits remain atomic.

Large libraries may use progressively more disk space, but memory and network use should scale with
page size and configured concurrency, not total membership. Surface storage exhaustion as an error,
never as silent reference truncation.

## Provenance and privacy

Adding a reference explicitly persists its identifier and a small metadata snapshot for offline
browsing. Store both the source's update date and the actual retrieval timestamp; saving, viewing,
or exporting must not invent a new retrieval time. Failed refreshes retain the prior snapshot,
marked stale with the failure shown separately. Refreshing metadata never rewrites user notes.

Do not fetch or persist full bill text or AI output merely because a reference was added. Saving an
excerpt or generated analysis requires an explicit user action and must preserve its source URL,
version, retrieval or generation time, model when applicable, and completeness/truncation notices.
Keep user-authored notes clearly labeled when exporting alongside retrieved or generated content.

No notebook content is sent to an AI provider on open, search replay, or export. Any future notebook
analysis must preview the selected sources and notes, disclose the destination and omissions, and
require explicit action. Unlimited notebook membership does not imply unlimited AI context.

Continue sanitizing untrusted terminal output and escaping rendered exports. Imports must not
execute note content, follow embedded URLs, or accept filesystem paths as record IDs. Credentials
and authorization headers must never appear in the research database or its exports.

## Export and portability

Provide a versioned JSON interchange format for lossless backup/import of searches, notebooks,
memberships, notes, citations, and retained provenance. Document required fields and validate all
objects before committing a normal-sized import. For large imports, stage and validate references
before inserting notes/citations, with an explicit resumable partial-import policy.

Preserve canonical legislation identity on import and deduplicate references. Import colliding
notebook, search, and note IDs as new IDs by default, remapping their relationships; replacing or
merging existing authored content must be an explicit choice. Unsupported versions must leave
existing data unchanged.

Add a Markdown notebook export with a reference index, user notes, source links, and limitations.
Adapt the existing serializers for other presentation formats after the basic workflow is stable.
Stream or batch large exports from storage rather than constructing one unbounded `ExportBundle`. An
entire-notebook export includes all references, not just the current page; resource limits must
produce a clear failure or an explicitly selected partitioned export, never silent omission.

## Archive format v1

The archive menu is `w` in the notebook library or an open notebook. `j` writes JSON, `m` writes
Markdown for the open notebook, `i` stages a JSON import, and `r` resumes a private stage. All
exports include the entire selected scope, regardless of the current page or filter. Only library
JSON includes saved searches. Markdown is a presentation export, not an import format.

JSON has exactly three root fields: `format: "billie-research"`, `version: 1`, and `records`, an
array of `{ "table": ..., "row": ... }` objects. Records follow the table order below. Row fields
are required; extra fields, duplicate JSON keys, unsupported versions, malformed values, invalid
relationships, and path-like IDs are rejected. IDs are nonempty ASCII letters/digits/underscore/
hyphen; revision/Congress/bill numbers are positive safe integers. Timestamps are parseable date
strings preserved verbatim, not regenerated on import.

| Table                    | Row fields                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `saved_searches`         | `id`, `name`, `query`, `bill_type`, `congress_mode`, `congress`, `created_at`, `updated_at`, `revision` |
| `notebooks`              | `id`, `title`, `description`, `created_at`, `updated_at`, `revision`                                    |
| `legislation_references` | `id`, `source`, `kind`, `congress`, `type`, `number`                                                    |
| `notebook_references`    | `notebook_id`, `reference_id`, `added_at`                                                               |
| `notes`                  | `id`, `notebook_id`, `title`, `body`, `created_at`, `updated_at`, `revision`                            |
| `note_citations`         | `note_id`, `notebook_id`, `reference_id`                                                                |
| `reference_metadata`     | `reference_id`, `snapshot`                                                                              |

The only source/kind is `congress.gov`/`bill`. Bill types use lowercase supported Congress codes.
`bill_type` may be null. Current-Congress searches have `congress_mode: "current"` and null
`congress`; fixed searches have a positive Congress. Titles/names/queries are nonblank. Note bodies
are verbatim Markdown. Generated-note notices, model names, and generation times remain part of that
editable body; they are not immutable authorship attestations.

`snapshot` is a JSON-encoded object with `title`, `sourceUrl`, `sourceUpdatedAt`, `retrievedAt`,
`limitations`, `refreshError`, and `attemptedAt`. `retrievedAt` may be null when refresh never
succeeded; `refreshError` is null or text; `limitations` is an array of strings. Source URLs are
credential-free HTTPS Congress.gov URLs without queries/fragments. An unresolved failed snapshot may
have an empty source URL. Metadata older than 24 hours, never retrieved, or failed is displayed as
stale; this is a local freshness threshold, not proof the legislation changed.

The streaming parser stages all records in a private database beside research storage, enforcing
schema constraints and foreign keys before any live writes. Live import commits at most 250 records
per transaction and records ID mappings/progress atomically in the same database. Every search,
notebook, and note gets a new ID; canonical references are reused. Existing metadata wins on
collisions, as disclosed before import. Import into an empty repository round-trips all content and
retained provenance; merging into a populated repository deliberately keeps its snapshots. Authored
timestamps/revisions and membership times are preserved. Internal import bookkeeping and unfinished
editor drafts are not part of archives.

If a batch fails or is cancelled, earlier commits remain visible, possibly as incomplete notebooks.
The reported private stage can be resumed across restarts using `w` then `r`; completed batches are
not repeated. Another instance cannot advance the same import unnoticed. Deleting imported records
before resuming may make remaining relationships invalid; restore them or start a fresh import. Keep
stages unchanged. Successful stages are retained for inspection/repeat-safe resume and may be
removed manually. Export writes a UUID-named private `.partial` file, syncs, then publishes it;
ordinary failures remove the partial file, while a process crash may leave one for manual cleanup.
Memory is bounded by a storage page/record and parser buffers, not total membership. A single large
note still requires memory proportional to that note; resource exhaustion is an explicit failure.

No configuration keys, authorization headers, full bill text, or automatic AI analysis are copied
into research archives. Text a user explicitly types or imports is preserved verbatim, including any
secrets they put in notes; inspect authored content before sharing. Opening, exporting, and
importing never send notebook content to AI. Prompt-only AI notes disclose destination/model and
send only the submitted prompt. Future notebook analysis remains gated on explicit source selection,
destination/omission disclosure, and confirmation; it is not enabled by this archive workflow.

## Recovery policy

Schema v4 adds minimal reference metadata and import checkpoints. Every existing-schema upgrade
first creates a private `.v<version>-<uuid>.bak` SQLite snapshot, including committed WAL data.
Migrations are additive and transactional; no destructive migration or automatic downgrade exists.
Unknown/future schemas are refused before modification. On migration failure, keep the reported
backup and original database. To restore, close every Billie process, preserve the database and its
`-wal`/`-shm` files together elsewhere, place a copy of the backup at the research database path
with mode 0600, and reopen with a compatible Billie version. Never replace a database while it is
open.

Permission, lock, and write failures are reported without silently dropping committed data.
Search/notebook form drafts remain in the active view after failed saves; they are not restart
recovery files. Notes written by Micro use private restart-recoverable drafts until saved/discarded.
Unwritten editor buffers cannot be recovered. Bulk operations explicitly retain/report completed
batches. No workflow promises durability after hardware/filesystem failure beyond SQLite and the
filesystem's synchronization guarantees.

## Implementation sequence

1. Validate the SQLite driver against compiled builds and packaging. Add the versioned research
   repository, migrations, path resolution, permissions, and transactional persistence tests.
2. Implement saved-search CRUD and replay through the current search command, preserving fixed or
   dynamic congress semantics and search coverage notices.
3. Implement notebook CRUD and paginated many-to-many membership independent of comparison marks.
   Add idempotent single and loaded-result batch additions and offline direct-reference entry.
4. Implement the `micro` editor adapter and safe terminal handoff, including runtime permissions and
   packaging. Add explicit multi-reference citations, deletion safeguards, and revision conflicts.
   Preserve navigation position and drafts through editor and persistence failures.
5. Add offline metadata snapshots, explicit refresh, lossless JSON import/export, and Markdown
   export.
6. Add fake-port application workflows and scale tests, update help and user documentation, and add
   a roadmap phase with completion checks once this design is accepted for implementation.

Keep persistence and notebook commands outside the terminal view class. Inject the research
repository alongside the existing application ports; use focused modules for domain validation,
storage, and commands instead of adding database access to rendering methods.

## Acceptance criteria

- Saved searches survive restart and replay the exact query and filters from offset zero. A dynamic
  congress resolves anew; a fixed congress does not change. Search result completeness remains
  visible.
- One notebook accepts at least 10,000 distinct references spanning multiple congresses and types in
  an automated scale fixture, with no membership cap. This is a test size, not a supported maximum.
- A note can cite more than two references, and a reference can belong to multiple notebooks.
  Duplicate additions do not create duplicate membership or discard notes.
- Opening a large notebook reads only a page and bounded metadata, verified with repository and
  network-call instrumentation. Offline opening requires no network calls.
- Notebook membership is unchanged by compare, reset, search rerun, or cancellation. Obsolete
  requests cannot restore removed membership or change the active view.
- Restart, concurrent edits, disk failures, and interrupted writes preserve committed data. Test
  migration rollback, future-schema rejection, foreign keys, and permission failures explicitly.
- Deletion cannot silently orphan citations. Note drafts survive failed saves, and conflicts are
  surfaced instead of overwriting another instance's edits.
- Editor tests cover Save, Discard, Continue editing, missing `micro`, nonzero exit, unreadable
  draft files, and repository save conflicts. Existing committed notes remain intact on failure.
- A PTY smoke test verifies that only `micro` consumes input during editing, background work does
  not repaint its screen, and Billie restores terminal mode, navigation, and one input reader after
  editor exit. Draft files are private and cleaned up only when no longer needed for recovery.
- JSON export/import round-trips relationships, notes, and provenance. Entire-notebook exports
  include references beyond the first page and retain partial/unavailable source notices.
- TUI tests cover create, add, note, reopen, replay, compare, export, cancel, and deletion
  workflows. Existing tests, `deno task check`, and compiled builds continue to pass with the chosen
  driver.
