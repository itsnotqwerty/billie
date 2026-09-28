{
  lib,
  stdenv,
  deno,
  typst,
  makeWrapper,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "billie";
  version = "1.0.0";

  # Repository root, two levels up from this file.
  src = ../../..;

  nativeBuildInputs = [
    deno
    makeWrapper
  ];

  buildPhase = ''
    runHook preBuild
    # The compiled module graph has no external dependencies, so no network
    # access is needed; only a writable Deno cache directory.
    export DENO_DIR="$TMPDIR/deno"
    deno task build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dist/billie $out/libexec/billie
    # Put Typst on PATH so PDF export works without a system-wide install.
    makeWrapper $out/libexec/billie $out/bin/billie \
      --prefix PATH : ${lib.makeBinPath [ typst ]}
    install -Dm644 README.md $out/share/doc/billie/README.md
    install -Dm644 docs/spec.md $out/share/doc/billie/spec.md
    install -Dm644 docs/design.md $out/share/doc/billie/design.md
    install -Dm644 docs/roadmap.md $out/share/doc/billie/roadmap.md
    runHook postInstall
  '';

  meta = {
    description = "AI-powered TUI for the Congress.gov API — search, compare, analyze legislation";
    homepage = "https://github.com/itsnotqwerty/billie";
    license = lib.licenses.mit;
    platforms = [ "x86_64-linux" ];
    mainProgram = "billie";
  };
})
