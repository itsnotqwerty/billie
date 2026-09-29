# Nix packaging for Billie

`package.nix` compiles Billie offline from this repository checkout and wraps the binary so `typst`
(PDF export) and `micro` (Markdown note editing) are always on `PATH`.

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

- The streaming JSON and Markdown parsers are fetched as pinned, hashed npm tarballs into a manual
  `node_modules` directory. Compilation disables remote resolution. Type checks run in the regular
  `deno task check` gate; sandbox compilation uses `--no-check` to avoid fetching Node type
  packages.
- The offline compile strategy and its compiled PTY test pass locally. An actual Nix derivation
  build still requires a host with Nix installed.
- `DENO_DIR` is redirected into the sandbox's `$TMPDIR` during the build.
- The wrapper puts `typst` and `micro` on `PATH` for Billie only; it does not alter the user
  profile.
