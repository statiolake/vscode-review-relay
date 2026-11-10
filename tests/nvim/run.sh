#!/bin/sh
# The Neovim frontend against the real review-relay: the one the plugin
# ships in bin/ (`npm run build:cli` rebuilds it from source): nvim --headless, a fresh git repository, its own sessions
# and stored reviews. NVIM=path/to/nvim picks the Neovim (default: nvim).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT
mkdir -p "$sandbox/tmp" "$sandbox/repo"
cd "$sandbox/repo"
git init -q && git config user.name Tester && git config user.email t@example.com
printf 'one\ntwo\nthree\nfour\nfive\n' > a.txt && git add a.txt && git commit -qm init
TMPDIR="$sandbox/tmp" XDG_CONFIG_HOME="$sandbox/config" HOME="$sandbox" \
  "${NVIM:-nvim}" --headless -u NONE -i NONE --cmd "set rtp^=$root" \
  -c "luafile $here/spec.lua"
