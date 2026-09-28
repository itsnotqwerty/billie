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
