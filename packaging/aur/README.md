# AUR packaging for Billie

This directory contains the Arch User Repository packaging files.

## Files

- `PKGBUILD` — build script for `makepkg`
- `.SRCINFO` — AUR metadata (generate with `makepkg --printsrcinfo > .SRCINFO` after editing)

## Local build

```bash
cd packaging/aur
makepkg -si
```

## Publishing to AUR

1. Create a repository on the AUR: `https://aur.archlinux.org/packages/billie`
2. Clone it: `git clone ssh://aur@aur.archlinux.org/billie.git aur-publish`
3. Copy `PKGBUILD` and `.SRCINFO` into it
4. Commit and push

## Notes

- The build requires `deno` (from `[extra]`) and `typst` (from `[extra]`) at build time.
- `typst` is a runtime dependency for PDF export; it is checked at install time by `install.sh`.
- The source URL assumes a GitHub release tag `v0.1.0`; adjust `url` and `source` if hosted
  elsewhere.
