# Billie

An AI-powered command line TUI for interacting with the [congress.gov](https://congress.gov) API.
Use the command line to search, view, compare, and analyze bills, amendments, and other legislation.

## Usage

```bash
billie
```

Press `i` to open the configuration menu and set your Congress.gov API key and (optionally) an AI
API key, model, and base URL. All values are entered and saved from within the app — no environment
variables are required.

## Controls

- `i`: Open the configuration menu (Congress.gov key, AI key, AI model, AI base URL). Press `l`
  there to fetch the models advertised by the configured endpoint and pick one from the list.
- API keys are masked while editing; submitting a blank key clears the saved value.
- `s`: Search bills by keyword/title, a bill number (e.g. `hr5676`), or part of a sponsor's name.
  Inside a verbatim text view (a bill or a side-by-side comparison), `s` searches the displayed text
  instead. `n` / `N`, Right/Left, and `.` / `,` jump to the next and previous match.
- `Enter`: View details of the selected bill.
- `Space` / `m`: Mark/unmark the selected bill in the results list (up to two). Marks are cleared
  when you return to the main menu.
- `c`: Compare the two marked bills (metadata + action-list diff).
- `a`: Analyze the open bill using AI. In comparison mode, enter a question about how the two bills
  differ; analysis fetches available verbatim text for the bill or both compared bills. Large texts
  are bounded, with omitted portions disclosed to the model.
- `x`: Toggle a bill's view between its historical overview and its verbatim text.
- `t`: Cycle the bill-type filter in the results list.
- `<` / `>`: Change the congress being searched, from the results list.
- `l`: Load the next batch of title-search results when the results view reports partial coverage.
- `o`: Open the saved-search library.
- `p`: Create a saved-search draft from the last completed query in the results view.
- `u`: Open research notebooks.
- `b`: Add the selected result or open bill to a notebook. `B` in results adds loaded results only.
- `w`: Open export options for the current bill, comparison, side-by-side text, or analysis. Choose
  Markdown, XML, JSON, CSV, HTML, or PDF; plain or formatted output; and the current visible view or
  the entire document. The default directory is `~/Documents`. Choose Directory and edit the path to
  change it; the new path is saved for future exports.
- `PgUp` / `PgDn`, `f` / `v`: Page through a long bill, comparison, analysis, or result list. In
  reading views, `f` pages down and `v` pages up.
- `Home` / `End` or `g` / `G`: Jump to the start or end of the current view.
- `z` / `Esc`: Go back, or cancel an in-flight request.
- `d`: Deselect everything and return to the main menu.
- `h`: Show help.
- `q`: Quit the application.

## Search and source coverage

Keyword search scans recently updated bill titles in batches of up to 1,500 records. The results
view reports how many records were scanned and whether more remain; press `l` to continue. A search
with no matches only describes the records searched so far. Direct references such as `hr5676` fetch
that bill directly, subject to the selected congress and bill-type filter.

Sponsor searches use membership from the selected Congress and paginate members and sponsored
legislation. Safety limits are 20 member pages, 20 matching sponsors, and 20 legislation pages per
sponsor (250 records per page). Limits and unavailable lookups are disclosed in the results view.

Unavailable or partial action/subject data is marked in views, comparisons, AI prompts, and exports.
Missing action history is not treated as evidence that an action occurred only in the other bill.
Verbatim text is capped at 400,000 characters, with the original length and an explicit truncation
notice preserved. AI receives at most 100,000 text characters for a single bill or 50,000 per bill
for a comparison; source limitations remain attached to analysis even if the model omits them.

## Saved searches

Press `o` to manage saved searches, or `p` from results to save the completed query and filters,
including searches with no matches. In the library, Up/Down select, Enter runs the selected search,
`n` creates one, `e` edits or renames, `u` duplicates, and `x` asks for deletion confirmation. `/`
filters by name, `l` and `b` navigate pages, `r` reloads, and Esc returns to the previous view.

In the definition editor, `n` edits the name, `q` edits the query, `t` cycles the bill-type filter,
`c` switches between fixed and current Congress, and `g` sets a fixed congress number. Enter accepts
a field, but only `w` saves the definition. Esc asks before discarding a draft. Failed saves retain
the draft; a concurrent edit requires reloading rather than overwriting the newer definition.

Saved searches default to a fixed congress. The explicit current-Congress option resolves when run.
Every replay starts at offset zero and retains normal search coverage notices; it does not persist
result lists or silently update the definition. Management works offline; replay requires a
Congress.gov API key.

Research data is stored separately from credentials at `$XDG_DATA_HOME/billie/research.sqlite3`,
falling back to `~/.local/share/billie/research.sqlite3`. If storage cannot be opened, Billie
reports the failure while keeping ordinary bill browsing available. Correct the storage problem and
restart to restore library access.

## Research notebooks

Press `u` to browse notebooks. The library lists each notebook with its reference and note counts.
`n` creates one, `e` edits its title and description, and `x` asks for deletion confirmation with
reference and note counts. In the editor, `n` edits the title, `d` edits the description, and `w`
explicitly saves. Esc asks before discarding changes. Failed saves retain the draft; stale revisions
cannot overwrite another instance's edits.

From results or bill details, `b` selects a destination notebook for that bill. In results, `B` is
**Add loaded results**, not all possible matches. Choose a notebook with Enter, or create one first.
Additions commit in batches of at most 250; Esc cancels remaining batches and reports committed,
already-present, and remaining counts. Enter retries remaining references after cancellation or a
failure. Repeated additions are idempotent, and legislation can belong to multiple notebooks.

Inside a notebook, `a` adds a reference offline using an explicit Congress, for example `119 hr1` or
`118 s2`. This validates identifier syntax, not whether the legislation exists. `/` filters
reference identities (or notebook titles in the library); `l` and `b` navigate pages; `r` reloads.
Enter fetches details. Space/`m` toggles any number of references across pages and filters; selected
rows show `*` and a selection count. Press `n`, choose a saved note, then `c` to review those
references in its citation picker; Enter applies them. `c` in the notebook explorer compares only
when exactly two references are selected. Esc returns from details to the same notebook page and
selection. There is no application-defined selection or membership cap; storage and memory limits
still apply.

Press `s` inside an open notebook to search Congress.gov for new references. In this search's
results or details, `b` adds the selected legislation directly to that notebook; repeated additions
report "already present". Enter opens details, `s` starts another search, `t` changes type, `</>`
changes Congress, and `l` continues partial results. Esc returns to the notebook's previous page and
filter with refreshed membership. This search requires a Congress.gov API key; searching or
cancelling alone does not add anything, and additions do not create note citations.

In notebook-search results, Space/`m` toggles references and `b` adds all marked references. In
note-citation search, Space/`m` toggles references and `c` cites all marked references. Selections
survive new queries and result continuation within the same destination. Returning to the notebook
or citations clears search selections without applying them. With no marks, these commands act on
the highlighted result; in details they act only on the open reference. Failed writes retain
unprocessed selections for retry and report committed progress; earlier commits are not rolled back.

Notebook management and reference browsing work without an API key. Explicitly adding fetched
results retains their title, source URL, source update date, actual retrieval time, and limitations.
Offline identifiers remain unresolved. Opening a notebook makes no API calls. Press `f` to refresh
the highlighted reference, or uppercase `F` to refresh only the current visible page. Page refreshes
run sequentially, show progress, and Esc cancels remaining requests. Old or failed snapshots are
marked stale; failures retain previous metadata and never change notes. Search replay, reset, and
comparison do not change persisted membership. Removing a reference affects only that notebook;
deleting a notebook leaves other notebooks intact. If notes cite a reference, ordinary removal is
blocked. `u` in the removal prompt opens a separate confirmation to unlink those citations and
remove the reference; note text is preserved unchanged. Deletion confirmations reject intervening
edits rather than silently deleting newer research.

Press `n` inside a notebook to open Notes. In Notes, `n` creates a titled draft, Enter reads the
selected note, `e` edits it in `micro`, and `x` confirms deletion. On an empty Notes list, `e`
starts a new titled draft. `/` searches note titles and bodies locally; an empty query clears the
filter. `l` and `b` page matching summaries; bodies load only when a note is opened. `r` reloads.
Editing and searching are local and do not require an API key or send note content to AI.

Press `w` on a saved note in the Notes list or reading view to open the same export menu used by
comparisons and analyses. Choose Markdown, XML, JSON, CSV, HTML, or PDF; formatted/plain style;
entire-document/current-view scope; and the destination directory. `e` in the export menu writes the
file, and Esc returns to Notes without changing your position. Entire-document exports include the
note body and all structured citations, not just the visible citation page. Exporting never modifies
the stored note or its citations. PDF export requires Typst.

While reviewing an unsaved draft, uppercase `W` opens this export menu without saving the draft to
the notebook. Lowercase `w` retains its Save behavior, including the direct Markdown copy for
AI-generated drafts. Draft exports are labelled unsaved; exporting does not discard recovery files.
These are individual-note snapshots, not lossless notebook backups or import bundles.

In Notes, `a` opens **Generate AI note**. Enter a prompt/query, then press Enter to send it to the
displayed AI endpoint and model. Configure the provider with `i` from the main menu first. Only the
prompt is sent: existing notes, notebook references, and selected citations are not included or
fetched automatically. Esc cancels generation; failures leave the prompt available for retry.

Generated Markdown opens as an unsaved private draft with an AI-generation notice. Press `e` to edit
it in Micro, or `w` to save directly without opening an editor. For these generated drafts, `w`
writes a uniquely named `.md` file in the configured export directory and saves the note in the
notebook; the resulting path is shown. `t` changes the title and `d` confirms discard. Generation
alone does not save a notebook note or create structured citations. Verify AI claims before use. The
Markdown export is a snapshot, not a live link to later edits of the saved notebook note.

If writing the Markdown file fails, the private draft is retained. If the file is written but the
notebook save fails, Billie reports the written path and keeps the draft for retry; retry may create
another uniquely named export. The filesystem and database writes are not one atomic transaction.

In `micro`, Ctrl-S writes the draft and Ctrl-Q returns to Billie. Billie then offers `w` Save, `d`
Discard (with confirmation), or `c`/`e` Continue editing. `t` changes the title; `k` saves a new
copy without structured citations. Closing `micro` never automatically commits a note. Existing
citations are unchanged when editing note text. Concurrent changes are detected on save rather than
overwritten; save a copy to keep conflicting work.

Drafts live in private `drafts/note-*/` directories beside the research database. Their recovery
paths are shown in the note review. Failed editor launches, reads, or saves retain the files; Ctrl-C
in Billie also leaves unfinished drafts intact. Press uppercase `R` in Notes to recover the latest
retained draft for that notebook after restart. Save or explicitly discard each recovered draft
before recovering another. Generated drafts are recoverable too; subsequent Micro changes must be
written to the draft to be recovered. After a successful commit or confirmed discard, Billie removes
the draft directory. Micro uses an isolated configuration there, with autosave, backups, persistent
undo, and cursor history disabled.

For a saved note, press `c` from the Notes list or reading view to manage structured citations.
Press `a` to browse references already in that notebook. Space/`m` toggles any number of references
across pages and filters; Enter adds all marked references, or the highlighted reference if none are
marked. Selection alone never saves citations. Additions commit in batches of at most 250; failed
batches remain selected for retry, while earlier committed batches are retained. Repeated additions
report "already cited"; there is no two-reference or page-size citation cap. Esc returns to the
citation list, where `x` asks before removing a citation. Each addition or confirmed removal commits
immediately and leaves the note text and notebook membership unchanged. In both lists, `/` filters
identities (for example `119 hr1`), `l`/`b` page, and `r` reloads after a concurrent edit. Esc
returns to the note or Notes list with its previous position preserved.

To find new sources, press `s` from either citation list: `c` -> `s` -> enter a query. This opens
the existing Congress.gov legislation search and requires an API key. In these results, `c` cites
the selected legislation and adds it to this note's notebook in one transaction; Enter opens its
details, where `c` also cites it. Repeat for multiple results, or press `s` for a new query. `t`
changes the bill type, `</>` changes Congress, and `l` continues partial title-search results. Esc
returns to citations. Searching alone never changes membership or notes, and ordinary search results
still use `c` for comparison. This is legislation search, not general web-article search.

The existing notebook picker and citation removal work offline. Save a new note before adding
citations; in unsaved draft review, `c` still means Continue in micro.

### Notebook archives

Press `w` in notebooks to open the archive menu: `j` exports versioned JSON, `m` exports a whole
notebook as Markdown, `i` imports JSON, and `r` resumes an interrupted import. In the library, JSON
includes all saved searches and notebooks; inside a notebook it includes that notebook and all its
references, notes, citations, and retained metadata. Export ignores page/filter limits. Enter a
destination directory, or leave it blank to use the configured export directory. Files are private
and only published after a complete write. Escape cancels; exports make no API or AI requests.

Imports validate the complete file in private staging before changing live data. Confirmation
explains the policy: create new notebook/search/note IDs, remap relationships, deduplicate canonical
references, and keep existing metadata on collisions. Notes are never overwritten. Commits contain
at most 250 records. Cancellation or failure retains earlier commits and reports the staging path;
use `w`, `r`, that path, and confirmation to resume without duplicating completed batches. Keep the
stage until import finishes; completed stages can be deleted manually. Do not edit staging
databases. Importing the original JSON again creates another copy. No embedded URL or Markdown is
executed.

See [the archive format and recovery guide](docs/saved-searches-and-notebooks.md#archive-format-v1)
for fields, conflict behavior, backup restoration, and privacy limits.

Schema v1 and v2 databases upgrade transactionally to v3, which adds notes and citations. Before
migration, SQLite creates a private `research.sqlite3.v<old-version>-<uuid>.bak` snapshot beside the
database, including committed WAL data. Migration failures roll back and report the backup path.
Backups are retained, not automatically restored or pruned. For manual recovery, stop every Billie
instance and preserve the current database and any `-wal`/`-shm` sidecars together before restoring
the snapshot as `research.sqlite3` without old sidecars. Restoring reverts changes made after the
snapshot; the next launch migrates it again.

## Local AI

Set the AI base URL and model in the `i` menu. HTTP(S) endpoints on `localhost`, `127.0.0.1`, or
`[::1]` work without an API key; for example, `http://localhost:11434/v1`. Clear any previously
saved AI key by submitting a blank value. Keyless requests omit the authorization header. Remote
endpoints still require an API key.

## Installation

`deno task build` compiles a binary with network access and permission to invoke only Typst and
Micro as subprocesses. Install `micro` for note editing; Billie checks its availability before
handing it the terminal and retains drafts if launch fails. AI analysis fetches bill text and sends
it to the configured endpoint (OpenAI by default, or any base URL set in the `i` menu). PDF export
uses the Typst compiler, which must be installed and available on `PATH` when Billie runs. The
installer checks for both Typst and Micro. AI provider requests use a separate two-minute timeout;
Congress.gov requests keep the shorter ten-second timeout. PDF export first creates a temporary
`.typ` source, converts Markdown pipe tables to native Typst tables, then compiles the source to
PDF.

The editor integration can be verified with `deno task build && python3 tests/micro_smoke.py` on
Linux with `micro` installed. It runs the real editor in an isolated PTY and temporary data
directory.

```bash
deno task build
./install.sh
```

### Arch Linux (AUR)

```bash
cd packaging/aur
makepkg -si
```

See [packaging/aur/README.md](packaging/aur/README.md) for publishing details.

### Debian / Ubuntu (.deb)

```bash
./packaging/debian/build-deb.sh
sudo dpkg -i dist/billie_1.0.0_amd64.deb
```

See [packaging/debian/README.md](packaging/debian/README.md).

### Fedora / RPM

```bash
rpmbuild -ba packaging/rpm/billie.spec
```

See [packaging/rpm/README.md](packaging/rpm/README.md).

### Nix

```bash
nix-build -E 'with import <nixpkgs> {}; callPackage ./packaging/nix/package.nix {}'
./result/bin/billie
```

The wrapper puts Typst on `PATH` automatically. See
[packaging/nix/README.md](packaging/nix/README.md).

## Documentation

- [Specification](docs/spec.md): product scope, requirements, data behavior, and acceptance
  criteria.
- [Design](docs/design.md): architecture, boundaries, reliability, privacy, and interface
  guidelines.
- [Roadmap](docs/roadmap.md): staged delivery plan and definition of done for each phase.
