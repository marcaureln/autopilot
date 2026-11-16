#!/bin/sh
# Runs as root while the dev container image builds. The native installer needs no Node.
set -eu

if [ -z "${VERSION:-}" ]; then
  echo "autopilot-claude-code: the version option is empty" >&2
  exit 1
fi

if ! command -v curl >/dev/null; then
  if command -v apt-get >/dev/null; then
    apt-get update -q && apt-get install -y -q --no-install-recommends curl ca-certificates
  elif command -v apk >/dev/null; then
    apk add --no-cache curl ca-certificates bash
  else
    echo "autopilot-claude-code: the image has no curl, apt-get or apk" >&2
    exit 1
  fi
fi

curl -fsSL https://claude.ai/install.sh | bash -s "$VERSION"
install -m 0755 "$HOME/.local/bin/claude" /usr/local/bin/claude
claude --version
