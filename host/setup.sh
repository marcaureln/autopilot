#!/usr/bin/env bash
set -euo pipefail

release="${1:?usage: setup.sh <release-dir> <rootless|rootful>}"
docker_mode="${2:?usage: setup.sh <release-dir> <rootless|rootful>}"
user=autopilot

step() { printf '==> %s\n' "$*"; }

step "prerequisites"
missing=()
command -v systemctl >/dev/null || missing+=("systemd: autopilot runs as a systemd service")
command -v docker >/dev/null || missing+=("Docker Engine: https://docs.docker.com/engine/install/")
if ! command -v mise >/dev/null && ! command -v apt-get >/dev/null; then
  missing+=("mise: https://mise.jdx.dev/installing-mise.html")
fi
if [ "$docker_mode" = rootless ]; then
  command -v dockerd-rootless-setuptool.sh >/dev/null || missing+=("Docker rootless extras: https://docs.docker.com/engine/security/rootless/")
  command -v newuidmap >/dev/null || missing+=("newuidmap (package uidmap): https://docs.docker.com/engine/security/rootless/#prerequisites")
  [ -e /usr/lib/systemd/user/dbus.socket ] || missing+=("systemd user session (package dbus-user-session): https://docs.docker.com/engine/security/rootless/#prerequisites")
fi
if [ "${#missing[@]}" -gt 0 ]; then
  printf 'missing: %s\n' "${missing[@]}" >&2
  exit 1
fi

if ! command -v mise >/dev/null; then
  step "mise"
  echo "INFO: mise is missing, installing it from its signed apt repository (https://mise.jdx.dev/installing-mise.html#apt)"
  install -dm 755 /etc/apt/keyrings
  curl -fsSL https://mise.jdx.dev/gpg-key.pub | gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg
  echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg] https://mise.jdx.dev/deb stable main" >/etc/apt/sources.list.d/mise.list
  apt-get update -q
  apt-get install -y -q mise
fi

step "user $user"
if ! id "$user" >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin "$user"
fi
uid=$(id -u "$user")

step "linger"
if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$user"
fi
for _ in $(seq 20); do [ -d "/run/user/$uid" ] && break; sleep 0.5; done

as_user() { sudo -u "$user" -H env XDG_RUNTIME_DIR="/run/user/$uid" MISE_TRUSTED_CONFIG_PATHS=/opt "$@"; }

if [ "$docker_mode" = rootless ]; then
  step "rootless docker"
  grep -q "^$user:" /etc/subuid || usermod --add-subuids 200000-265535 "$user"
  grep -q "^$user:" /etc/subgid || usermod --add-subgids 200000-265535 "$user"
  if ! as_user systemctl --user is-active --quiet docker; then
    as_user dockerd-rootless-setuptool.sh install
  fi
  docker_host="unix:///run/user/$uid/docker.sock"
else
  step "rootful docker"
  echo "WARNING: rootful mode puts $user in the docker group, so $user controls Docker as root" >&2
  id -nG "$user" | grep -qw docker || usermod -aG docker "$user"
  docker_host="unix:///var/run/docker.sock"
fi

step "cli $release"
chown -R "$user:$user" "$release"
as_user mise --cd "$release" install --yes
as_user mise --cd "$release" exec -- pnpm install --prod --frozen-lockfile --silent
ln -sfn "$release" /opt/autopilot

step "service"
unit=$(cat <<EOF
[Unit]
Description=autopilot
After=network-online.target
Wants=network-online.target

[Service]
User=$user
WorkingDirectory=/opt/autopilot
Environment=DOCKER_HOST=$docker_host
Environment=MISE_TRUSTED_CONFIG_PATHS=/opt
ExecStart=$(command -v mise) --cd /opt/autopilot exec -- node src/cli.ts run --host /etc/autopilot/host.json
LoadCredential=app-key:/etc/autopilot/app-key
LoadCredential=claude-token:/etc/autopilot/claude-token
LoadCredential=op-token:/etc/autopilot/op-token
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF
)
if [ "$(cat /etc/systemd/system/autopilot.service 2>/dev/null)" != "$unit" ]; then
  printf '%s\n' "$unit" >/etc/systemd/system/autopilot.service
  systemctl daemon-reload
fi
systemctl enable --quiet autopilot
systemctl restart autopilot
step "done: $(systemctl is-active autopilot)"
