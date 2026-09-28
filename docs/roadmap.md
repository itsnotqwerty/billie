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

## Later opportunities

- Saved searches and local research notebooks.
- More legislation types and richer text-version comparison.
- Additional AI providers and local models.
- Configurable export templates and additional output formats.
- Optional collaboration or shareable, provenance-preserving bundles.
