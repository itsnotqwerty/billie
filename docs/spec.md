# Billie Specification

## Product definition

Billie is a keyboard-first terminal user interface for researching US legislation. It combines
Congress.gov records with optional AI-assisted explanations while keeping the original government
data discoverable and authoritative.

## Goals

- Find relevant bills and amendments quickly.
- Present legislative metadata in a readable, scannable form.
- Compare two records without losing their source context.
- Make complex legislative language easier to understand with optional analysis.
- Work acceptably when AI is unavailable.
- Export useful research artifacts to local files.

## Non-goals

- Replacing Congress.gov as the authoritative source.
- Providing legal, policy, or voting advice.
- Predicting whether legislation will pass or what its effects will be.
- Editing, submitting, or voting on legislation.
- Scraping sources that are not part of the supported public API.

## Primary use cases

### Search

Users can search by free-text query and narrow results by congress, chamber, bill type, sponsor, and
status when the API supports those filters. Results show enough identifying information to
distinguish similarly titled records.

### Inspect

A detail view presents the bill number, title, congress, chamber, sponsors, cosponsors when
available, subjects, latest action, introduced date, update date, and links to source text and the
Congress.gov record. Missing fields are shown as unavailable rather than inferred.

### Compare

Users can select two compatible records. Billie provides a metadata comparison and, when both source
texts are retrievable, a text diff. Comparisons identify which source versions were used and report
unavailable sections clearly.

### Analyze

Users can request a structured AI analysis of a selected record. Billie fetches the available
verbatim text before analysis; comparison questions include each bill's available text. Text sent to
the provider is bounded, and omitted portions are explicitly disclosed. If required text cannot be
retrieved, analysis fails rather than silently falling back to metadata alone. An analysis should
include a plain-language summary, key provisions or differences, affected parties, implementation or
funding details when present, uncertainties, and source references. The UI must label generated
content and show the model/provider used.

In reading views, `f` pages down and `v` pages up. `Home` / `End` and `g` / `G` jump to the start or
end of the current view.

### Export

Users can export a bill overview or verbatim text, metadata comparison, aligned side-by-side text,
or AI analysis/summary as Markdown, XML, JSON, CSV, HTML, or PDF. The export menu selects plain or
formatted output and either the visible current view or the entire document. Exports use unique
timestamped names in `~/Documents` by default; a directory edited in the menu is persisted in the
configuration file. Exported AI content includes source URLs, retrieval timestamps, model metadata,
and a generated-content notice. PDF output is compiled with Typst, which must be installed at
runtime.

## Functional requirements

1. Startup must fail with a useful message when required configuration is missing.
2. Network requests must have timeouts, bounded retries, and rate-limit handling.
3. Search results must support loading, empty, error, and stale-cache states.
4. Navigation and selection must be possible without an AI provider.
5. Source records and generated analysis must remain visually distinct.
6. Every displayed record must link back to its Congress.gov source.
7. Export must avoid overwriting an existing file without explicit confirmation.
8. API keys and provider credentials must never appear in logs or exports.
9. The application must provide a cancel path for slow network and AI operations.

## Data and configuration

The initial integration should use the Congress.gov API and its documented resource identifiers.
Configuration names should be centralized and documented when implementation begins. At minimum, the
application will need a Congress.gov API key, an optional AI provider key, a request timeout, and an
export directory.

## Acceptance criteria for the first usable release

- A user can launch Billie, configure the Congress.gov key, search, and open a result.
- Detail views expose source metadata and links without fabricated values.
- A failed request leaves the user in a recoverable state.
- AI analysis is optional, clearly labeled, and source-linked.
- Each supported export format preserves the active record/comparison/analysis data and provenance.
- Keyboard help accurately reflects every available command.

## Open decisions

- Which Deno TUI library will provide rendering and input handling?
- Which AI providers and models will be supported first?
- Should local caching be opt-in, automatic, or disabled initially?
- Which legislative text formats can be diffed reliably in the first release?
