Name:           billie
%global debug_package %{nil}
%global __strip /bin/true
Version:        1.2.0
Release:        1%{?dist}
Summary:        AI-powered TUI for the Congress.gov API

License:        MIT
URL:            https://github.com/itsnotqwerty/billie
Source0:        %{url}/archive/refs/tags/v%{version}.tar.gz

BuildRequires:  deno
# Only PDF export needs Typst at runtime; keep it optional for minimal systems.
Recommends:     typst
Requires:      micro

%description
Billie is a terminal UI for searching, comparing, and analyzing US
legislation via the Congress.gov API, with optional AI-assisted
analysis through any OpenAI-compatible endpoint.

%prep
%autosetup -n %{name}-%{version}

%build
deno task build

%check
deno task check

%install
install -Dm755 dist/billie %{buildroot}%{_bindir}/billie
install -Dm644 README.md %{buildroot}%{_docdir}/%{name}/README.md
install -Dm644 docs/spec.md %{buildroot}%{_docdir}/%{name}/spec.md
install -Dm644 docs/design.md %{buildroot}%{_docdir}/%{name}/design.md
install -Dm644 docs/roadmap.md %{buildroot}%{_docdir}/%{name}/roadmap.md
install -Dm644 docs/saved-searches-and-notebooks.md %{buildroot}%{_docdir}/%{name}/saved-searches-and-notebooks.md

%files
%{_bindir}/billie
%doc %{_docdir}/%{name}

%changelog
* Tue Sep 29 2026 Samuel Roux <office@gatewaycorporate.org> - 1.2.0-1
- Research notebooks, notes, citations, and archive import/export
- Disable stripping/debug extraction to preserve the Deno executable payload
* Mon Sep 28 2026 Samuel Roux <office@gatewaycorporate.org> - 1.0.0-1
- Initial package
