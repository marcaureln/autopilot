#!/bin/sh
# Runs as root while the dev container image builds, and in the Dockerfile of the agent image.
set -eu

if [ -z "${VERSION:-}" ]; then
  echo "autopilot-opencode: the version option is empty" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *)
    echo "autopilot-opencode: OpenCode has no build for $(uname -m)" >&2
    exit 1
    ;;
esac
# Alpine and other musl images need the musl build, which links the C++ runtime.
if ls /lib/ld-musl-* >/dev/null 2>&1; then
  arch="$arch-musl"
  if command -v apk >/dev/null; then apk add --no-cache libstdc++ libgcc; fi
fi

# From SHA256SUMS of the GitHub release. A new version needs its four lines here.
case "$VERSION-$arch" in
  2.3.0-x64) sha256=fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b ;;
  2.3.0-arm64) sha256=3207fb5cdec448d479242c0f1a14f4f7bdfcad3a79209b5eb8f9003725e93711 ;;
  2.3.0-x64-musl) sha256=dcefa5e90cbd3dc37f7d9741854854021b4b4d495644a6c2bfaf5b0c1634c986 ;;
  2.3.0-arm64-musl) sha256=a0c7a2cbde0f888fe784e31170332f738db1f110509dc3981f5a2760c6323c40 ;;
  *)
    echo "autopilot-opencode: no pinned checksum for OpenCode $VERSION ($arch)" >&2
    exit 1
    ;;
esac

if ! command -v curl >/dev/null; then
  if command -v apt-get >/dev/null; then
    apt-get update -q && apt-get install -y -q --no-install-recommends curl ca-certificates
  elif command -v apk >/dev/null; then
    apk add --no-cache curl ca-certificates
  else
    echo "autopilot-opencode: the image has no curl, apt-get or apk" >&2
    exit 1
  fi
fi

tmp=$(mktemp -d)
curl -fsSL -o "$tmp/opencode.tar.gz" "https://github.com/anomalyco/opencode/releases/download/v$VERSION/opencode-linux-$arch.tar.gz"
echo "$sha256  $tmp/opencode.tar.gz" | sha256sum -c -
tar -xzf "$tmp/opencode.tar.gz" -C "$tmp"
install -m 0755 "$tmp/opencode" /usr/local/bin/opencode
rm -r "$tmp"
opencode --version
