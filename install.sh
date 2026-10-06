#!/bin/sh
# Install git-drift as a standalone binary (no Node.js needed). macOS and Linux.
#   curl -fsSL https://raw.githubusercontent.com/chiefsmurph/git-drift/main/install.sh | sh
# Options (env): GIT_DRIFT_VERSION=0.2.1 (default: latest)  GIT_DRIFT_INSTALL_DIR=~/bin (default: ~/.local/bin)
set -eu
REPO=chiefsmurph/git-drift
VERSION="${GIT_DRIFT_VERSION:-latest}"
DIR="${GIT_DRIFT_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo "git-drift: $(uname -s) isn't supported (macOS and Linux only)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) echo "git-drift: CPU $(uname -m) isn't supported (arm64 and x86_64 only)" >&2; exit 1 ;;
esac
asset="git-drift-$os-$arch.tar.gz"
if [ "$VERSION" = latest ]; then base="https://github.com/$REPO/releases/latest/download"
else base="https://github.com/$REPO/releases/download/v${VERSION#v}"; fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
echo "git-drift: downloading $asset ($VERSION)"
fetch "$base/$asset" "$tmp/$asset"
fetch "$base/checksums.txt" "$tmp/checksums.txt"

want=$(grep " $asset\$" "$tmp/checksums.txt" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/$asset" | cut -d' ' -f1)
else got=$(shasum -a 256 "$tmp/$asset" | cut -d' ' -f1); fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then
  echo "git-drift: checksum mismatch for $asset, not installing" >&2
  exit 1
fi

tar -xzf "$tmp/$asset" -C "$tmp"
mkdir -p "$DIR"
mv "$tmp/git-drift" "$DIR/git-drift"
chmod +x "$DIR/git-drift"
echo "git-drift: installed $("$DIR/git-drift" --version) to $DIR/git-drift"
case ":$PATH:" in
  *":$DIR:"*) ;;
  *) echo "git-drift: $DIR is not on your PATH. Add it, e.g.:  export PATH=\"$DIR:\$PATH\"" ;;
esac
