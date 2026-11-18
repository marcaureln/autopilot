#!/bin/sh
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
# Alpine and other musl images need the musl build, which links the C++ runtime. ldd names the C
# library in use: a glibc image can have the musl package installed too.
if ldd --version 2>&1 | grep -qi musl; then
  arch="$arch-musl"
  if command -v apk >/dev/null; then apk add --no-cache libstdc++ libgcc; fi
fi

# From SHA256SUMS of the GitHub release.
case "$VERSION-$arch" in
  2.3.1-x64) sha256=2f9ac6811d45831f80741b75e94fbe121fd3fa8ba7ecde3381814ed7410f1820 ;;
  2.3.1-arm64) sha256=7be3d4efa0844badd66f1f76d8a7597edeb3c26adfed89393b6ddac31dcde358 ;;
  2.3.1-x64-musl) sha256=20d167630914e2179b0958c4f4d653a33a3fa050ab66d3beb2d677bb685b7183 ;;
  2.3.1-arm64-musl) sha256=aafe8ae239689fdeff3ed88ce21fb6137beccd3d6587a5f7e11eb0b68b781698 ;;
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
