{
  lib,
  stdenv,
  deno,
  typst,
  micro,
  makeWrapper,
  fetchurl,
}:

stdenv.mkDerivation (finalAttrs: {
  pname = "billie";
  version = "1.2.0";

  # Repository root, two levels up from this file.
  src = ../../..;
  dontStrip = true;

  nativeBuildInputs = [
    deno
    makeWrapper
  ];

  parserSource = fetchurl {
    url = "https://registry.npmjs.org/@streamparser/json/-/json-0.0.22.tgz";
    hash = "sha256-l3dHNkAhoDHiIUiQm0GRuqbPsy2H0+BWCjQySnQN/VA=";
  };

  markdownSource = fetchurl {
    url = "https://registry.npmjs.org/marked/-/marked-17.0.1.tgz";
    hash = "sha256-0JvEBndItxrxMaJhVQGTz++6AU9nlx84kPImkpP1pgs=";
  };

  buildPhase = ''
    runHook preBuild
    mkdir -p node_modules/@streamparser/json node_modules/marked
    tar -xzf "$parserSource" --strip-components=1 -C node_modules/@streamparser/json
    tar -xzf "$markdownSource" --strip-components=1 -C node_modules/marked
    export DENO_DIR="$TMPDIR/deno"
    deno compile --no-check --cached-only --no-remote --node-modules-dir=manual \
      --allow-env --allow-read --allow-write --allow-net --allow-run=typst,micro \
      --output dist/billie src/main.ts
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dist/billie $out/libexec/billie
    # Put Typst on PATH so PDF export works without a system-wide install.
    makeWrapper $out/libexec/billie $out/bin/billie \
      --prefix PATH : ${lib.makeBinPath [ typst micro ]}
    install -Dm644 README.md $out/share/doc/billie/README.md
    install -Dm644 docs/spec.md $out/share/doc/billie/spec.md
    install -Dm644 docs/design.md $out/share/doc/billie/design.md
    install -Dm644 docs/roadmap.md $out/share/doc/billie/roadmap.md
    install -Dm644 docs/saved-searches-and-notebooks.md $out/share/doc/billie/saved-searches-and-notebooks.md
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
