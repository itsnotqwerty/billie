# Billie Roadmap

The roadmap is ordered by dependency. Dates are intentionally omitted until the project has a
working build and a measured development cadence.

## Phase 0: Foundation

**Outcome:** a runnable Deno project with a repeatable local workflow.

- [x] Add Deno configuration, tasks, formatting, linting, and type checking.
- [x] Establish the application state model and command registry.
- [x] Choose and integrate the TUI rendering library. (Deviation: implemented a small
      dependency-free raw-mode terminal layer in `src/ui/terminal.ts` instead of adopting a
      third-party TUI library.)
- [x] Implement startup, quit, help, and a visible status area.
- [x] Add configuration loading with secret-safe error messages.

**Exit check:** the app launches locally, responds to core navigation keys, and passes formatting,
lint, and type checks. **Met** (`deno task check`, 24 unit tests passing). lint, and type checks.

## Phase 1: Congress.gov search

**Outcome:** users can search and inspect authoritative records.

- [x] Implement a typed Congress.gov adapter.
- [x] Add query input, filters, result list, loading, empty, and error states. (Query input,
      congress/type filters (`t`, `</>`), result list, and loading/empty/error states all done.
      Search merges title/number matches with sponsor-name matches via member lookup; a direct bill
      number always resolves to a single, still-browsable results row instead of jumping straight to
      detail.)
- [x] Add detail view with metadata, actions, subjects, and source links. (Metadata, sponsors,
      subjects, actions, source link, and verbatim bill text (`x` to toggle) done; cosponsor rosters
      still open.)
- [x] Add timeout, retry, rate-limit, and cancellation behavior.
- [x] Add fixture tests for normal and malformed API responses.

**Exit check:** a configured user can search and open a record without AI access. **Met** — keyword,
bill-number, and sponsor-name search all resolve to a browsable results list.

## Phase 2: Compare and export

**Outcome:** users can produce useful research artifacts from public data.

- [x] Add two-record selection and compatibility checks. (Space marks up to two bills; `c` compares
      the marked pair.)
- [x] Normalize available source text and implement a readable diff. (Field-by-field metadata
      comparison plus an LCS-based diff of the actions list; full bill-text diff still open.)
- [x] Add multi-format export for records, comparisons, side-by-side text, and analysis. (`w` opens
      an export menu for Markdown, XML, JSON, CSV, HTML, and PDF, with style/scope choices.)
- [x] Add overwrite confirmation and export error handling. (Deviation: exports always use a unique
      timestamped filename, which prevents overwrites without a prompt.)
- [x] Include source URLs and retrieval metadata in every export.

**Exit check:** a user can compare two supported records and open the resulting Markdown outside
Billie. **Met** for metadata/actions comparison; full-text diff remains open.

## Phase 3: AI-assisted analysis

**Outcome:** optional explanations improve comprehension without obscuring provenance.

- [x] Define a provider-neutral AI port and one initial adapter. (OpenAI-compatible chat completions
      adapter in `src/ai/provider.ts`; works with OpenAI and most local servers via a configurable
      base URL.)
- [x] Create a structured analysis schema with validation. (`parseAnalysisJson` validates summary,
      keyProvisions, affectedParties, uncertainties.)
- [x] Add analysis progress, cancellation, failure, and retry states.
- [x] Render generated content separately from source facts.
- [x] Fetch and include available verbatim bill text for single-bill and comparison analysis, with
      bounded excerpts and explicit truncation notices.
- [x] Add citations, model metadata, uncertainty markers, and analysis export. (Analysis view and
      Markdown export label the model and link the source record.)

**Exit check:** analysis can be enabled or disabled independently, and no generated claim is
rendered without source context. **Met** — the AI key/model/base URL are configured entirely through
the `i` menu (no environment variables required) and analysis always shows the source URL.

## Phase 4: Quality and release

**Outcome:** Billie is dependable for regular research use.

- Add bounded caching with freshness indicators.
- [x] Improve keyboard ergonomics for long bills. (Page Up/Down, `f` page-down, `v` page-up,
      Home/End, `g`/`G`, and in-text find with `s` / `n` / `N` in verbatim and comparison text
      views.)
- [x] Add comparison-mode AI questions grounded in the metadata and action differences.
- [x] Add end-to-end smoke coverage with mocked providers. (Provider tests mock the full
      request/response cycle; UI tests cover terminal rendering and input handling.)
- [x] Render PDF exports with Typst and document/check the runtime dependency.
- [x] Document configuration, troubleshooting, and release installation. (README covers
      configuration, controls, and installation; `packaging/` contains the per-distro builds.)
- [x] Package a versioned release and verify installation on supported environments. (AUR in
      `packaging/aur/`, Debian `.deb` via `packaging/debian/build-deb.sh`, Fedora RPM spec in
      `packaging/rpm/`, and a Nix derivation in `packaging/nix/` that wraps Typst onto PATH.)

**Exit check:** a fresh user can install, configure, use, and troubleshoot the first release from
the documentation alone. **Met** — the README and `packaging/` together cover installation,
configuration, usage, and troubleshooting.

## Phase 5: Correctness and data trust

**Outcome:** requests, search results, source limitations, credentials, and terminal input remain
trustworthy during everyday use and failure recovery.

These priorities come from the [2026-09-28 review](improvements.md), ordered by impact versus
effort. Effort estimates include focused regression tests. The review baseline was 73 passing tests
and a passing `deno task check`; synthetic probes reproduced the findings without live-service
validation.

### 1. Fix request races and stale results

**Impact: high. Effort: medium.**

Cancelled requests clear newer progress, empty searches retain previous results, and late responses
can reopen results after reset. Guard callbacks by request identity, abort on reset, and explicitly
replace results on empty responses.

- [x] Fix request ownership, cancellation, reset, and empty-result transitions in
      [application orchestration](../src/ui/app.ts).

### 2. Sanitize terminal output

**Impact: high. Effort: small.**

Retrieved content and AI responses can carry terminal escape sequences directly into stdout;
truncation does not remove them. Sanitize content at the rendering boundary while preserving
application-generated controls.

- [x] Sanitize untrusted content in [terminal rendering](../src/ui/terminal.ts).

### 3. Mask secret entry and consistently redact errors

**Impact: high. Effort: small.**

API keys are displayed verbatim while being entered. The existing redaction utility is not applied
to UI diagnostics. Mask credential fields and route displayed errors through it.

- [x] Mask credential input in [the UI](../src/ui/app.ts) and apply
      [secret redaction](../src/config.ts) to displayed diagnostics.

### 4. Stop presenting incomplete data as complete

**Impact: high. Effort: medium.**

Failed actions/subjects requests become empty arrays, and text beyond 400,000 characters disappears
without an export warning. Represent unavailable, empty, and truncated data separately; propagate
limitations into comparisons, AI prompts, and exports.

- [x] Preserve and disclose retrieval failures and truncation from the
      [Congress.gov adapter](../src/api/congress.ts) through the UI, AI, and export paths.

### 5. Make search coverage explicit, then improve pagination

**Impact: high. Effort: medium.**

Search scans only 1,500 recent bills, at most 500 current members, two matching sponsors, and one
page of each sponsor's legislation. Historical searches also use current members. These limits can
produce misleading "no matches" results. Disclose coverage, support pagination, and use
congress-appropriate membership.

- [x] Add explicit search coverage, pagination, and historical member lookup in the
      [search adapter](../src/api/congress.ts) and results UI.

Title scans now continue in batches with `l`. Member and sponsored-legislation lookups follow
pagination, use the selected Congress for membership, and disclose safety caps or failed lookups.
Sponsor matches respect the bill-type filter.

### 6. Add CI and application-state tests

**Impact: high leverage. Effort: small to medium.**

Existing tests do not exercise the orchestration where the reproduced bugs occur, and no checked-in
CI workflow was found. Add fake-port tests for cancellation, reset, empty results, and failed
retrievals; run them with the existing quality gate in CI.

- [x] Test [application state](../src/ui/app.ts) with fake ports and automate the
      [quality gates](../deno.json) in CI.

The [CI workflow](../.github/workflows/ci.yml) installs Deno and Typst, then runs formatting, lint,
type checks, tests, and a compiled build. [Application tests](../src/ui/app_test.ts) exercise actual
keyboard flows with fake terminal and API ports.

### 7. Support keyless local AI endpoints consistently

**Impact: medium. Effort: small.**

Model discovery supports an empty key, but application initialization disables analysis without one.
Instantiate the provider for valid keyless configurations and omit empty authorization headers.

- [x] Enable keyless local analysis in [provider initialization](../src/ui/app.ts) and
      [chat requests](../src/ai/provider.ts).

Keyless analysis is enabled for valid HTTP(S) loopback endpoints (`localhost`, `127.0.0.1`, and
`[::1]`). Remote providers still require a key. Blank credential input clears a saved key.

### 8. Make keyboard parsing stream-aware

**Impact: medium. Effort: medium.**

An arrow sequence split across reads becomes Escape plus literal characters. UTF-8 characters can
also split. Buffer incomplete sequences and use streaming decoding, with tests across chunk
boundaries.

- [x] Implement stream-aware [keyboard parsing](../src/ui/terminal.ts).

The decoder buffers split UTF-8 and escape sequences and resolves standalone Escape after a short
timeout without starting competing reads.

**Exit check:** regression tests cover all eight priorities, incomplete data is visible in research
artifacts, and CI runs formatting, lint, type checks, and tests successfully. **Met locally** with
96 passing tests, `deno task check`, and `deno task build`. Hosted CI execution remains pending.

## Phase 6: Saved searches and research notebooks

**Outcome:** durable local searches and research notebooks with no application-defined limit on
legislation references. The [detailed plan](saved-searches-and-notebooks.md) governs data semantics,
privacy, editor handoff, scale, and acceptance criteria. These are research notebooks, not
executable Jupyter notebooks; cloud sync, collaboration, alerts, and automatic notebook AI are out
of scope.

### Foundation and storage

- [~] Validate SQLite in Deno, compiled binaries, CI, and supported packages before choosing a
  driver. Deno 2.9.4's built-in `node:sqlite` passes a local compiled persistence smoke test with
  only read/write permissions, without FFI or an external SQLite dependency. Current AUR/RPM
  packages and an isolated offline Nix-style compilation pass the real-terminal suite. Native
  Debian/Nix builds and hosted CI for the current worktree remain pending.
- [x] Add a versioned research repository under the XDG data directory, separate from credentials.
      [ResearchStore](../src/research/store.ts) provides schema v4 for saved searches, notebooks,
      notes, citations, canonical membership, minimal metadata, and atomic resumable-import
      checkpoints.
- [x] Enforce private files, foreign keys, transactional migrations, future-schema rejection,
      revision conflicts, bounded locking, and safe backup/recovery behavior. Upgrades from v1/v2/v3
      create private SQLite snapshots including WAL data; migration rollback and backup restoration
      are tested. Only additive migrations are supported; destructive migrations and automatic
      downgrades are refused/not implemented. The detailed plan documents manual recovery with all
      processes closed.
- [x] Preserve committed data and recoverable drafts on permission, disk, migration, or save
      failure. Search/notebook drafts survive failed saves; bulk additions retain committed batches
      and retry remaining references. Private editor drafts survive launch/read/save failures and
      can be recovered after restart; only content written by the editor is recoverable.
      Search/notebook forms remain in memory, not restart recovery files. Permission, lock, injected
      write-failure, migration, and interrupted-import tests preserve committed data and report
      partial progress.

### Saved searches

- [x] Persist named query/filter definitions with IDs, timestamps, revisions, and explicit fixed or
      current-Congress selection; never persist credentials, result lists, or pagination offsets.
      Repository CRUD, name filtering, keyset pagination, and stale-edit rejection are implemented;
      startup opens the store and closes it on exit. Storage failures do not disable bill browsing.
- [x] Add browse, name filter, create, edit, rename, duplicate, and delete commands. `o` opens the
      library and `p` captures a completed results query, including empty results. Draft saves and
      discard/delete confirmations are handled by [SavedSearchView](../src/ui/saved_searches.ts).
- [x] Replay through existing search orchestration from offset zero, preserving coverage notices.
      Fixed/current Congress and type filters are restored; changing a draft cancels pending replay.
- [x] Require explicit saves and notebook additions; replay must not alter notebook membership.
      Saved definitions change only on explicit save, with conflict detection and draft recovery.
      Notebook membership changes only through explicit add/remove commands.

### Notebooks and citations

- [x] Add notebook CRUD and paginated many-to-many legislative membership, independent of the
      temporary two-bill comparison marks. Support multiple congresses and supported record types.
- [x] Support idempotent additions from results, detail, and offline validated references, including
      an explicit "Add loaded results" action that does not imply all matches were searched.
- [x] Add Markdown notes citing zero, one, or any number of notebook references, with transactional
      membership constraints, revision checks, deletion safeguards, and recoverable drafts.
      Repository CRUD, body-preserving edits, paginated citations, and composite foreign keys are
      implemented. Notebook deletion confirms note counts; cited references require explicit unlink
      confirmation. Notes supports micro editing, explicit saves/discards, revision-safe recovery,
      and paginated browsing. `c` on a saved note opens filtered citations; `a` opens a
      same-notebook reference picker, Enter adds, and `x` confirms removal. Writes reject stale
      revisions and work offline.
- [x] Preserve notebook position when opening details or comparing two references; reset and search
      cancellation must not remove persisted research.

Citation search follow-up: `c` on a saved note now leads to `s` for Congress.gov legislation search.
Contextual `c` on a result or detail atomically adds notebook membership and its citation; Esc
returns to citations. This reuses search filters, continuation, and coverage notices, while the
existing-reference picker remains offline. Tests cover multiple sources, duplicates, stale
revisions, transactional rollback, missing credentials, and cancelled/late requests.

Notebook explorer search: `s` inside an open notebook searches Congress.gov; `b` in the resulting
list or details adds directly to the original notebook without creating citations. Esc restores its
page/filter and refreshes membership. Tests cover duplicates, multiple additions, detail and repeat
searches, cancellation and late responses, reset, missing credentials, failed writes, and deletion
of the target notebook.

Multiselect follow-up: Space/`m` now selects any number of references in notebooks, citation
pickers, and contextual searches. Notebook selections carry into Notes for explicit citation review.
Enter applies picker selections in batches of 250; `c`/`b` applies marked citation/notebook search
results. Failed writes retain remaining selections and report partial progress. Comparison requires
exactly two selections but no longer caps notebook selection. Tests cover 300 picker selections
across pages and filters, multi-query selection, deselection, retry, and cancellation.

### Micro editor

- [x] Integrate `micro` as the external multiline Markdown editor with private draft files and an
      injectable editor port. Keep short names and queries in Billie's existing input fields.
- [x] Implement exclusive terminal handoff: settle pending stdin reads, suspend background repaints,
      restore normal terminal mode, and spawn without a shell using inherited standard streams.
      Command keys are yielded before another read; handoff refuses pending reads and drops buffered
      pre-editor keys on return. App and terminal repaint guards cover asynchronous callbacks.
- [x] Restore the TUI on all exit paths and offer Save, Discard, or Continue editing. Commit with a
      revision check and retain private recovery files on failure until explicit resolution. `R`
      recovers the latest draft; Save copy preserves conflicting work without copying citations.
- [x] Update subprocess permissions, installer checks, distro dependencies, Nix paths, and CI tests.
      Only `typst,micro` are allowed subprocesses. CI installs Micro and runs the real-editor PTY
      test; hosted CI and fresh package builds remain unverified locally.

### Scale, provenance, and portability

Individual-note export menu: saved-note `w` (list or reader) and draft-review `W` reuse the shared
type/style/scope/directory controls. Entire-note exports include Markdown and every paginated
structured citation; JSON/XML/CSV retain structured fields. Exporting does not save drafts or mutate
notes. Unit tests cover navigation, 55 citations, and unsaved-draft preservation; compiled PTY tests
write all six formats, change directory/scope, and recover from write failures. Whole-notebook
JSON/Markdown archives now use a separate streaming path rather than an unbounded export bundle.

AI note creation: Notes `a` accepts an explicit prompt with destination/model disclosure. It sends
only that prompt, never notebook contents implicitly. Generation is cancellable; successful output
opens a private recoverable draft with an AI-generation notice. `e` edits in Micro and `w` saves
both a Markdown snapshot and the notebook note without requiring editing. Failed file writes keep
the draft; a later database failure reports the already-written file and retains recovery. Unit
tests and the compiled PTY smoke test cover direct save, real editing, cancellation, provider
errors, recovery, and file-write retry. Live external model quality is not verified.

- [x] Use indexed keyset pagination and bounded transactions, memory, and fetch concurrency. Page
      sizes and API/AI limits must never become notebook membership caps. Notebook lists read
      50-entry pages; additions commit at most 250 per transaction, yield between batches, and
      report partial progress on cancellation/failure. Opening notebooks makes no API calls. Note
      and citation lists are independently paged without loading note bodies; citation writes are
      bounded to 250 changes per transaction, not per note. Imports stage streaming JSON before live
      writes, commit at most 250 records, yield between batches, and atomically checkpoint resumable
      progress. Memory scales with a page/single record, not total notebook membership;
      exceptionally large notes may exhaust resources.
- [x] Retain minimal offline metadata with real retrieval times, explicit refresh, stale/error
      states, and completeness notices. Do not automatically store full text or generated analysis.
      API responses carry retrieval timestamps; explicit additions retain snapshots. Notebook `f`
      refreshes only the highlighted reference, preserving prior data on failure and leaving notes
      alone.
- [x] Add versioned lossless JSON import/export with validation, ID remapping, deduplication, and
      explicit conflict/partial-import policies; add Markdown notebook exports with reference
      indexes. Notebook/library `w` opens JSON/Markdown export, confirmed import, and resume. Strict
      staging rejects unsupported schemas, unknown/duplicate fields, path IDs, and invalid
      relationships. Authored entities get new IDs; references deduplicate; existing metadata wins
      on collisions.
- [x] Export the entire notebook in bounded batches, not just its visible page. Preserve provenance,
      user/generated-content distinctions, and source limitations without silent omissions. Tests
      round-trip 10,000 references, citations, retrieval times, and partial/unavailable notices.
      Generated notices are preserved verbatim as editable Markdown, not immutable attestations.
- [x] Keep credentials out of research data and require explicit source selection and destination
      disclosure before any future notebook AI request. No configuration/auth headers enter
      archives; metadata URLs reject credential parameters. AI notes send only the explicit prompt
      with endpoint/model disclosure. Future notebook analysis remains disabled pending source
      preview/selection and confirmation. User-authored text is preserved verbatim, so users must
      not place secrets in notes they intend to share.

### Verification

- [x] Test persistence, migrations, rollback, corruption, permissions, concurrent edits, and export
      round trips; storage, malformed-archive rejection, 10,000-reference round trips, canonical
      deduplication, cancellation after a committed batch, and repeat-safe resume tests pass.
- [x] Exercise at least 10,000 references in one notebook as a scale fixture, not a supported
      maximum; paged storage access and cross-notebook membership pass. A note with 500 citations
      verifies independent paging and no two-reference or batch-size citation cap.
- [x] Add fake-port keyboard workflows and editor failures, plus a real PTY smoke test proving
      exclusive editor input, suppressed background rendering, and reliable terminal restoration.
      Real Micro edits, continues, saves, discards, and recovers across two compiled PTY sessions.
      Fake ports verify repaint suppression, launch failure, conflict and disk-failure recovery.
- [~] Update help and user documentation and pass checks, tests, compiled builds, and packaging
  gates. Help, archive fields/policies, and recovery docs are updated. 186 tests, quality gates,
  compiled Micro/archive PTY tests, AUR/RPM builds and extracted package binaries pass locally.
  Native Debian/Nix builds are unavailable on this host; CI now includes a Debian package smoke.
  Hosted CI run 36518397024 passed for the prior remote commit, not these uncommitted changes.

**Exit check:** saved searches replay correctly after restart, notebooks scale without a membership
cap, notes and citations survive failures, and `micro` editing returns safely to Billie. Feature
implementation is complete locally; the two partial checkboxes above retain external release
verification requirements rather than claiming unexecuted gates passed.

**Initial implementation:** six [storage tests](../src/research/store_test.ts) cover XDG paths,
private persistence, concurrent revision conflicts, validation, pagination, and refusal to alter
corrupt or unsupported databases. The store is wired into startup and saved-search commands.
[Saved-search controller tests](../src/ui/saved_searches_test.ts) and
[application tests](../src/ui/app_test.ts) cover explicit saves, CRUD, pagination, conflicts,
offline management, fixed/current replay, empty-result saving, storage failures, and cancellation.

**Saved-search integration verified locally:** 113 tests pass, quality checks and compilation pass,
and a two-session compiled PTY smoke test covers creation, explicit save, restart persistence,
current-Congress selection, offline replay warnings, and terminal restoration.

**Notebook integration verified locally:** 127 tests pass, quality checks and compilation pass.
Twelve storage tests include a 10,000-reference fixture, v1 migration with rollback and private
backup, committed WAL snapshot data, canonical identity, duplicate membership, and revision
conflicts. [Notebook controller tests](../src/ui/notebooks_test.ts) cover offline entry,
confirmations, paging, comparison marks, recoverable drafts, and batch cancellation/failure.
Application tests verify loaded-result additions, offline use, stale request rejection, and return
position. A two-session compiled PTY smoke test confirms cross-Congress membership persistence,
deletion cancellation, private storage, and terminal restoration.

**Note persistence and deletion safeguards verified locally:** 138 tests pass, quality checks and
compilation pass. Twenty storage tests cover Markdown round trips, optimistic conflicts, invalid
citation rollback, cross-notebook constraints, 500-citation paging, v2 migration/backup restoration,
and failed-unlink rollback. Notebook tests cover explicit unlink confirmation, note-count previews,
and concurrent edits. A two-session compiled PTY smoke test confirms blocked/cancelled removal,
explicit unlinking without note-text loss, restart persistence, deletion counts, and terminal
restoration.

**Micro integration verified locally:** 150 tests pass and quality checks pass. The compiled binary
passes [the real-editor PTY test](../tests/micro_smoke.py) with Micro 2.0.15: multiline input,
Continue editing, explicit Save/Discard, private recovery after restart, and terminal restoration.
[Editor tests](../src/research/editor_test.ts) cover private storage and symlink refusal;
[Notes tests](../src/ui/notes_test.ts) cover revision conflicts, failed-save retry, paging, and
citation preservation.

**Citation UI verified locally:** 157 tests pass, quality checks and compilation pass. Notes tests
add 300 citations through six 50-reference pages, and cover filtering, duplicate additions,
confirmed removal, concurrent edits, failed writes, deleted membership, and unchanged Markdown. An
offline application test verifies navigation and counts. The compiled real-Micro PTY test now adds
three cross-Congress citations, preserves them across editing and restart, and removes one without
deleting notebook membership. Offline metadata snapshots and notebook import/export are now
implemented; hosted CI and fresh package verification are tracked in the release gates above.

## Phase 7: Research workflow ergonomics

**Outcome:** faster discovery and maintenance inside existing notebooks without expanding network,
privacy, collaboration, or destructive-migration scope. The [next-features plan](next-features.md)
governs this phase.

- [x] Search note titles and bodies offline with bounded keyset paging. `/` in Notes matches titles
      and bodies case-insensitively, preserves paging, clears with an empty query, and loads a body
      only when a matching note is opened.
- [x] Refresh metadata for the current notebook page with explicit action, cancellation, and
      previous-snapshot preservation. Uppercase `F` refreshes visible references sequentially;
      failures retain old snapshots and leave notes unchanged.
- [x] Show notebook reference and note counts using bounded aggregate queries. The library lists
      `title (N references, M notes)`, computed once per page reload.
- [x] Validate application and package versions together.
      [version_test.ts](../packaging/version_test.ts) fails the test suite if AUR, Debian, Nix, or
      RPM manifests diverge from [deno.json](../deno.json); all manifests are aligned at 1.2.0.
- [ ] Verify native Debian and Nix package builds when available.

## Later opportunities

- More legislation types and richer text-version comparison.
- Additional AI providers and local models.
- Configurable export templates and additional output formats.
- Optional collaboration or shareable, provenance-preserving bundles.
