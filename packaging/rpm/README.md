# Fedora/RPM packaging for Billie

## Build

On Fedora (or any rpm-based distro with `rpm-build` and `deno`):

```bash
# From the repo root, after tagging v1.0.0 and pushing to GitHub:
spectool -g -R -C ~/rpmbuild/SOURCES packaging/rpm/billie.spec   # fetch the source tarball
cp packaging/rpm/billie.spec ~/rpmbuild/SPECS/
rpmbuild -ba ~/rpmbuild/SPECS/billie.spec
```

The binary RPM lands in `~/rpmbuild/RPMS/x86_64/`. Install with:

```bash
sudo dnf install ~/rpmbuild/RPMS/x86_64/billie-1.0.0-1.*.x86_64.rpm
```

For a COPR build, upload the SRPM from `~/rpmbuild/SRPMS/` instead.

## Notes

- `BuildRequires: deno` — Fedora ships `deno` in its official repositories.
- `Recommends: typst` — only PDF export needs Typst at runtime; DNF installs it by default but
  minimal/image builds can skip it.
- The spec expects a GitHub release tag `v1.0.0`; `Release:`/`%changelog` and the AUR `pkgver`
  should be bumped together with the tag.
