#!/usr/bin/env bash
# Docker on macOS runs per user (OrbStack, Colima, Docker Desktop), so autopilot runs as a launchd
# agent of that user, not as a daemon of a separate user. All its files stay in that user's home.
set -euo pipefail

release="${1:?usage: setup-macos.sh <release-dir> <rootless|rootful>}"
docker_mode="${2:?usage: setup-macos.sh <release-dir> <rootless|rootful>}"

# shellcheck source=scripts/common.sh
. "$release/scripts/common.sh"

if [ "$(id -u)" -eq 0 ]; then
  echo "run setup on macOS as the user who runs Docker, not as root" >&2
  exit 1
fi
# A non-interactive ssh session has no Homebrew in its PATH.
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
base="$HOME/.autopilot"
logs="$HOME/Library/Logs/autopilot"
label=autopilot
plist="$HOME/Library/LaunchAgents/$label.plist"
job="gui/$(id -u)/$label"

step "prerequisites ($(sw_vers -productName) $(sw_vers -productVersion))"
missing=()
if ! command -v docker >/dev/null; then
  missing+=("Docker: OrbStack (https://orbstack.dev), Colima (https://github.com/abiosoft/colima) or Docker Desktop (https://docs.docker.com/desktop/setup/install/mac-install/)")
elif ! docker info >/dev/null 2>&1; then
  missing+=("a running Docker engine: start OrbStack, Colima or Docker Desktop until docker info works")
elif ! docker compose version >/dev/null 2>&1; then
  # The dev containers of the repos run their services with Docker Compose.
  missing+=("Docker Compose: https://docs.docker.com/compose/install/ (OrbStack and Docker Desktop include it; with Colima, brew install docker-compose)")
fi
if ! command -v brew >/dev/null; then
  command -v mise >/dev/null || missing+=("mise: https://mise.jdx.dev/installing-mise.html (or Homebrew, https://brew.sh, and setup installs it)")
  command -v op >/dev/null || missing+=("1Password CLI: https://developer.1password.com/docs/cli/get-started/ (or Homebrew, https://brew.sh, and setup installs it)")
fi
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'missing: %s\n' "${missing[@]}" >&2
  exit 1
fi

if ! command -v mise >/dev/null; then
  step "mise"
  echo "INFO: mise is missing, installing it with Homebrew (https://mise.jdx.dev/installing-mise.html#homebrew)"
  brew install --quiet mise
fi
if ! command -v op >/dev/null; then
  step "1password cli"
  echo "INFO: op is missing, installing it with Homebrew (https://developer.1password.com/docs/cli/get-started/)"
  brew install --quiet --cask 1password-cli
fi

step "docker"
docker_host=$(docker context inspect --format '{{.Endpoints.docker.Host}}')
echo "INFO: rootless Docker does not apply on macOS: the containers run in the VM of $(docker context show), which isolates them from this Mac"
[ "$docker_mode" = rootless ] || echo "INFO: \"docker\": \"$docker_mode\" in host.json has no effect on macOS"

step "cli $release"
tools=$base/tools
install -d -m 755 "$base" "$tools" "$base/bin" "$HOME/Library/LaunchAgents"
# Colima shares only the home folder with its VM, and the jobs mount folders from TMPDIR.
install -d -m 700 "$base/tmp" "$logs"
tool_mise "$release" "$tools" install --yes
tool_mise "$release" "$tools" exec -- pnpm install --prod --frozen-lockfile --silent
node=$(tool_mise "$release" "$tools" which node)
ln -sfn "$release" "$base/current"

step "launchd agent $plist"
path="$(dirname "$node"):$(dirname "$(command -v docker)"):$(dirname "$(command -v op)"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
agent=$(cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node</string>
    <string>$base/current/src/cli.ts</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$base/current</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DOCKER_HOST</key>
    <string>$docker_host</string>
    <key>PATH</key>
    <string>$path</string>
    <key>TMPDIR</key>
    <string>$base/tmp</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>StandardOutPath</key>
  <string>$logs/autopilot.log</string>
  <key>StandardErrorPath</key>
  <string>$logs/autopilot.log</string>
</dict>
</plist>
EOF
)
if [ "$(cat "$plist" 2>/dev/null)" != "$agent" ]; then
  printf '%s\n' "$agent" >"$plist"
fi

step "command $base/bin/autopilot"
wrapper=$(cat <<EOF
#!/bin/sh
exec $node $base/current/src/cli.ts "\$@"
EOF
)
if [ "$(cat "$base/bin/autopilot" 2>/dev/null)" != "$wrapper" ]; then
  printf '%s\n' "$wrapper" >"$base/bin/autopilot.tmp"
  chmod 755 "$base/bin/autopilot.tmp"
  mv "$base/bin/autopilot.tmp" "$base/bin/autopilot"
fi

# launchctl kickstart keeps the plist it loaded, so a changed plist needs bootout and bootstrap.
if launchctl print "$job" >/dev/null 2>&1; then
  launchctl bootout "$job"
  for _ in $(seq 20); do launchctl print "$job" >/dev/null 2>&1 || break; sleep 0.5; done
fi
launchctl bootstrap "gui/$(id -u)" "$plist"
printf '{"at":"%s","event":"host.updated","release":"%s","by":"%s"}\n' "$(date -u +%FT%TZ)" "$release" "$(id -un)" >>"$logs/audit.log"

step "cleanup"
prune_releases "$release" "$tools" "" "$base"/releases/*

if [ "$(pmset -g | awk '$1 == "sleep" { print $2 }')" != 0 ]; then
  echo "WARNING: this Mac sleeps when it is idle, and autopilot stops while it sleeps. Turn on System Settings > Energy > Prevent automatic sleeping when the display is off, or keep caffeinate -s running" >&2
fi
echo "INFO: autopilot runs while $(id -un) is logged in; after a restart, log in again"
step "done: $(launchctl print "$job" | awk '$1 == "state" { print $3; exit }')"
