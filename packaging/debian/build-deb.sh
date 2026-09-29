#!/usr/bin/env bash
# Build a .deb package for Billie using dpkg-deb (no debhelper needed for a
# single prebuilt binary). Run from anywhere: ./packaging/debian/build-deb.sh
set -euo pipefail

cd "$(dirname "$0")/../.."

version=$(sed -n 's/^Version: //p' packaging/debian/control)
arch=$(sed -n 's/^Architecture: //p' packaging/debian/control)

deno task build

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

install -Dm755 dist/billie "$staging/usr/bin/billie"
install -Dm644 README.md "$staging/usr/share/doc/billie/README.md"
install -Dm644 docs/spec.md "$staging/usr/share/doc/billie/spec.md"
install -Dm644 docs/design.md "$staging/usr/share/doc/billie/design.md"
install -Dm644 docs/roadmap.md "$staging/usr/share/doc/billie/roadmap.md"
install -Dm644 docs/saved-searches-and-notebooks.md "$staging/usr/share/doc/billie/saved-searches-and-notebooks.md"
install -Dm644 packaging/debian/copyright "$staging/usr/share/doc/billie/copyright"
install -Dm644 packaging/debian/control "$staging/DEBIAN/control"

mkdir -p dist
dpkg-deb --build --root-owner-group "$staging" "dist/billie_${version}_${arch}.deb"

echo "Built dist/billie_${version}_${arch}.deb"
