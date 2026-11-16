#!/bin/sh
# Installs the autopilot client for the current user, without root:
#   curl -fsSL https://raw.githubusercontent.com/marcaureln/autopilot/main/install.sh | sh
#   sh install.sh v1.2.3    # a given release instead of the latest
set -eu

repo=marcaureln/autopilot
data="${XDG_DATA_HOME:-$HOME/.local/share}/autopilot"
bin="$HOME/.local/bin"

fail() {
  echo "$*" >&2
  exit 1
}
command -v curl >/dev/null || fail "missing: curl"
command -v tar >/dev/null || fail "missing: tar"
command -v mise >/dev/null || fail "missing: mise (https://mise.jdx.dev/installing-mise.html)"

tag=${1:-$(curl -fsSL "https://api.github.com/repos/$repo/releases/latest" | sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p')}
printf '%s\n' "$tag" | grep -Eqx 'v[0-9]+\.[0-9]+\.[0-9]+' || fail "\"$tag\" is not a release tag such as v1.2.3"

dir="$data/$tag"
if [ ! -d "$dir" ]; then
  echo "==> download $tag"
  rm -rf "$dir.tmp"
  mkdir -p "$dir.tmp"
  curl -fsSL "https://github.com/$repo/archive/refs/tags/$tag.tar.gz" | tar -xz --strip-components=1 -C "$dir.tmp"
  mv "$dir.tmp" "$dir"
fi

echo "==> node and dependencies"
release_mise() { (cd "$dir" && MISE_TRUSTED_CONFIG_PATHS="$dir" mise "$@"); }
release_mise install --yes
release_mise exec -- pnpm install --prod --frozen-lockfile --silent
node=$(release_mise which node)
ln -sfn "$dir" "$data/current"

echo "==> command $bin/autopilot"
mkdir -p "$bin"
printf '#!/bin/sh\nexec %s %s/current/src/cli.ts "$@"\n' "$node" "$data" >"$bin/autopilot.tmp"
chmod 755 "$bin/autopilot.tmp"
mv "$bin/autopilot.tmp" "$bin/autopilot"

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "INFO: $bin is not in your PATH: add it in your shell's rc file" ;;
esac
echo "==> done: autopilot $tag. Next: autopilot setup"
