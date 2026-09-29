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

## Local AI

Set the AI base URL and model in the `i` menu. HTTP(S) endpoints on `localhost`, `127.0.0.1`, or
`[::1]` work without an API key; for example, `http://localhost:11434/v1`. Clear any previously
saved AI key by submitting a blank value. Keyless requests omit the authorization header. Remote
endpoints still require an API key.

## Installation

`deno task build` compiles a binary with network access and permission to invoke Typst. AI analysis
fetches bill text and sends it to the configured endpoint (OpenAI by default, or any base URL set in
the `i` menu). PDF export uses the Typst compiler, which must be installed and available on `PATH`
when Billie runs. The installer checks for it. AI provider requests use a separate two-minute
timeout; Congress.gov requests keep the shorter ten-second timeout. PDF export first creates a
temporary `.typ` source, converts Markdown pipe tables to native Typst tables, then compiles the
source to PDF.

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
