# Prioritized improvements

Review date: 2026-09-28.

Prioritize correctness and data trust over new features. The following improvements are ranked by
impact versus effort, with effort estimates including focused regression tests.

## 1. Fix request races and stale results

**Impact: high. Effort: medium.**

Reproduced: cancelled requests clear newer progress; empty searches retain previous results; late
responses reopen results after reset. Guard callbacks by request identity, abort on reset, and
explicitly replace results on empty responses.

References: [search orchestration](../src/ui/app.ts#L762), [reset](../src/ui/app.ts#L198).

## 2. Sanitize terminal output

**Impact: high. Effort: small.**

Retrieved content and AI responses can carry terminal escape sequences directly into stdout.
Truncation does not remove them. Sanitize content at the rendering boundary while preserving
application-generated controls.

Reference: [terminal rendering](../src/ui/terminal.ts#L180).

## 3. Mask secret entry and consistently redact errors

**Impact: high. Effort: small.**

API keys are displayed verbatim while being entered. A redaction utility exists but is not applied
to UI diagnostics. Mask credential fields and route displayed errors through it.

References: [credential input](../src/ui/app.ts#L1304), [redactSecrets](../src/config.ts#L87).

## 4. Stop presenting incomplete data as complete

**Impact: high. Effort: medium.**

Confirmed: failed actions/subjects requests become empty arrays, and text beyond 400,000 characters
disappears without an export warning. Represent unavailable, empty, and truncated data separately;
propagate limitations into comparisons, AI prompts, and exports.

References: [detail retrieval](../src/api/congress.ts#L354),
[text truncation](../src/api/congress.ts#L393).

## 5. Make search coverage explicit, then improve pagination

**Impact: high. Effort: medium.**

Search scans only 1,500 recent bills, at most 500 current members, two matching sponsors, and one
page of each sponsor's legislation. Historical searches also use current members. These limits can
produce misleading "no matches" results. Immediately disclose coverage; then support pagination and
congress-appropriate membership.

Reference: [member and bill search](../src/api/congress.ts#L267).

## 6. Add CI and application-state tests

**Impact: high leverage. Effort: small to medium.**

The existing tests pass, but none exercise the application orchestration where the reproduced bugs
occur. Add fake-port tests for cancellation, reset, empty results, and failed retrievals; run them
with the existing quality gate in CI. No checked-in CI workflow was found during this review.

References: [App](../src/ui/app.ts#L91), [deno.json](../deno.json).

## 7. Support keyless local AI endpoints consistently

**Impact: medium. Effort: small.**

Model discovery supports an empty key, but application initialization disables analysis without one.
Instantiate the provider for valid keyless configurations and omit empty authorization headers.

References: [provider initialization](../src/ui/app.ts#L137),
[chat requests](../src/ai/provider.ts#L298).

## 8. Make keyboard parsing stream-aware

**Impact: medium. Effort: medium.**

Confirmed: an arrow sequence split across reads becomes Escape plus literal characters. UTF-8
characters can also split. Buffer incomplete sequences and use streaming decoding, with tests across
chunk boundaries.

Reference: [keyboard parsing](../src/ui/terminal.ts#L74).

## Verification

All 73 tests and `deno task check` passed at review time. Findings were checked with synthetic
probes; no live-service validation or implementation changes were made as part of the review. Source
line references reflect the code at review time.
