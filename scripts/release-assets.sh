#!/bin/sh
# Builds the release's prebuilt cores into DIR (default: release/):
# review-relay-<os>-<arch>.tar.gz, each holding the one executable
# (review-relay, or review-relay.exe on Windows: the platforms the VSIX ships), and
# SHA256SUMS over them, the layout build.lua downloads from a GitHub release.
# Pure Go without cgo, so it cross-compiles from anywhere; needs Go.
set -eu
cd "$(dirname "$0")/.."
name=review-relay
out=${1:-release}
targets="darwin-arm64 darwin-amd64 linux-amd64 linux-arm64 windows-amd64 windows-arm64"
rm -rf "$out"
mkdir -p "$out"
for target in $targets; do
  goos=${target%-*} goarch=${target#*-}
  stage="$out/stage-$target"
  exe=$name
  if [ "$goos" = windows ]; then exe=$name.exe; fi
  mkdir -p "$stage"
  CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch \
    go build -trimpath -ldflags='-s -w' -o "$stage/$exe" "./cmd/$name"
  tar -czf "$out/$name-$target.tar.gz" -C "$stage" "$exe"
  rm -rf "$stage"
done
(cd "$out" && sha256sum -- *.tar.gz > SHA256SUMS)
