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

## Later opportunities

- Saved searches and local research notebooks.
- More legislation types and richer text-version comparison.
- Additional AI providers and local models.
- Configurable export templates and additional output formats.
- Optional collaboration or shareable, provenance-preserving bundles.
