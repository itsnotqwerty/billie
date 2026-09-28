# Nix packaging for Billie

`package.nix` builds Billie from this repository checkout with `deno task
build` and wraps the
binary so `typst` (for PDF export) is always on `PATH`.

## Build from a checkout

```bash
nix-build -E 'with import <nixpkgs> {}; callPackage ./packaging/nix/package.nix {}'
./result/bin/billie
```

Or with flakes enabled, from the repository root:

```bash
nix build --impure --expr '(import <nixpkgs> {}).callPackage ./packaging/nix/package.nix {}'
```

## Use from another flake

```nix
{
  inputs.billie.url = "github:itsnotqwerty/billie";
  # Then, where pkgs is available:
  # pkgs.callPackage "${inputs.billie}/packaging/nix/package.nix" {}
}
```

## Notes

- The compiled module graph has no external dependencies (`@std/assert` is test-only), so no Deno
  dependency vendoring or fixed-output hash is needed.
- `DENO_DIR` is redirected into the sandbox's `$TMPDIR` during the build.
- The wrapper puts `typst` on `PATH` for Billie only; it does not pollute the user profile. Override
  or drop the `typst` argument to build a smaller closure without PDF export.
