# Debian packaging for Billie

Builds a `.deb` with `dpkg-deb` — no debhelper or source-package machinery is needed because Billie
ships as a single compiled binary.

## Requirements

- `deno` (to compile the binary)
- `dpkg-deb` (from `dpkg`, installed by default on Debian/Ubuntu; available on other distros as
  `dpkg`)

## Build

```bash
./packaging/debian/build-deb.sh
```

The package is written to `dist/billie_1.0.0_amd64.deb`. Install it with:

```bash
sudo dpkg -i dist/billie_1.0.0_amd64.deb
```

## Notes

- `typst` is a `Recommends` (not a hard dependency): only PDF export needs it, and it is not yet
  packaged in every Debian/Ubuntu release.
- Bump `Version:` in `control` together with the release tag.
