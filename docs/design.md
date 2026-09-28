# Billie Design

## Design direction

Billie should feel like a focused research instrument: dense enough for repeated investigation, calm
under failure, and explicit about the difference between retrieved facts and generated
interpretation. The interface should prioritize scanability and keyboard flow over decorative UI.

## Architecture

Use a layered design with narrow boundaries:

```text
Input and views
        |
Application state and commands
        |
Use cases: search, inspect, compare, analyze, export
        |
Ports: legislation API, text retrieval, AI provider, filesystem
        |
Adapters and infrastructure
```

### Presentation layer

Owns terminal rendering, focus, key bindings, help, status messages, and accessibility-friendly
color choices. It should not construct API URLs, parse provider responses, or call an AI SDK
directly.

### Application layer

Owns commands, selection state, navigation history, cancellation, and orchestration. Commands should
return typed success or failure results so views can render errors without catching
provider-specific exceptions.

### Domain layer

Defines normalized legislation records, source references, text versions, comparisons, analysis
results, and export documents. Domain types should preserve source identifiers and timestamps so
provenance cannot be dropped accidentally.

### Infrastructure layer

Implements Congress.gov access, text retrieval, AI provider calls, caching, configuration, and file
output. Adapters must map external payloads into domain types and validate response shapes at the
boundary.

## State guidelines

- Keep one explicit application state model rather than deriving behavior from terminal widgets.
- Represent loading, success, empty, stale, and error states separately.
- Treat selected records as stable identifiers, not copies of mutable result rows.
- Make undo a history of user commands or state snapshots with a bounded size.
- Cancel obsolete searches and analysis requests when the user starts a newer operation.

## API and AI reliability

- Use a single request client with timeouts, retry policy, rate-limit awareness, and redacted
  diagnostics.
- Keep AI analysis timeouts separate from API timeouts so larger bill-text prompts have time to
  complete without slowing ordinary Congress.gov requests.
- Cache successful public responses where useful, and show when displayed data is cached.
- Validate external JSON before it enters the domain layer.
- Send the retrieved bill text needed for analysis, bounded to a documented limit; disclose any
  omitted text in the prompt and fail analysis if the required text cannot be retrieved.
- Require structured AI output and validate it before rendering.
- Never present an AI claim without nearby source references or an explicit uncertainty marker.

## Terminal interaction

- Keep the current context visible: query, selected record, congress, and data freshness.
- Preserve selection while moving between search, detail, comparison, and analysis views.
- Use consistent key bindings and expose them through an always-available help view.
- Provide a visible, non-blocking status area for network and export progress.
- Ensure every operation has a keyboard cancellation or return path.
- Keep export serialization independent of the menu and preserve structured provenance for records,
  comparisons, side-by-side text, and generated analysis.
- Render PDF exports by writing a temporary `.typ` source, translating Markdown pipe tables to
  native Typst tables, and compiling the source with the Typst executable. Treat Typst as an
  explicit runtime dependency, clean up temporary files, and report compiler failures to the user.
- Do not rely on color alone for status, source type, or errors.

## Security and privacy

- Read secrets from environment variables or an ignored local config path.
- Redact API keys, authorization headers, and prompt contents from logs.
- Avoid storing source text or generated analysis unless caching is explicitly enabled.
- Write exports with restrictive permissions where the platform allows it.
- Treat retrieved content as untrusted input and escape it for terminal rendering and Markdown
  output.

## Testing strategy

- Unit test normalization, comparison, retry decisions, redaction, export formatting, and persisted
  export-path behavior.
- Use fixture-based adapter tests for Congress.gov and AI response shapes.
- Test command transitions with a fake clock and fake ports.
- Keep terminal rendering tests focused on key states and keyboard routing.
- Add a small end-to-end smoke test covering configure, search, inspect, and export with mocked
  network calls.

## Definition of done

A feature is done when its domain behavior is tested, failures are recoverable, source provenance is
preserved, keyboard help is updated, and the README or relevant specification no longer describes
behavior inaccurately.
