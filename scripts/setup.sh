#!/usr/bin/env bash
set -euo pipefail

release="${1:?usage: setup.sh <release-dir> <rootless|rootful>}"
docker_mode="${2:?usage: setup.sh <release-dir> <rootless|rootful>}"
user=autopilot

# shellcheck source=scripts/common.sh
. "$release/scripts/common.sh"

case "$(uname -s)" in
  Linux) ;;
  Darwin) exec bash "$release/scripts/setup-macos.sh" "$release" "$docker_mode" ;;
  *)
    echo "autopilot hosts run Linux or macOS, not $(uname -s)" >&2
    exit 1
    ;;
esac

# Host setup writes the op token only for a host.json with op:// references.
op_token=/etc/autopilot/op-token
install_op=false
if [ -f "$op_token" ] && ! command -v op >/dev/null; then install_op=true; fi

# shellcheck source=/dev/null
step "prerequisites ($(. /etc/os-release && echo "$PRETTY_NAME"))"
missing=()
command -v systemctl >/dev/null || missing+=("systemd: autopilot runs as a systemd service")
command -v docker >/dev/null || missing+=("Docker Engine: https://docs.docker.com/engine/install/")
# The dev containers of the repos run their services with Docker Compose.
if command -v docker >/dev/null && ! docker compose version >/dev/null 2>&1; then
  missing+=("Docker Compose plugin (package docker-compose-plugin): https://docs.docker.com/compose/install/linux/")
fi
if ! command -v mise >/dev/null && ! command -v apt-get >/dev/null; then
  missing+=("mise: https://mise.jdx.dev/installing-mise.html")
fi
if $install_op && ! command -v apt-get >/dev/null; then
  missing+=("1Password CLI: https://developer.1password.com/docs/cli/get-started/")
fi
if ! git lfs version >/dev/null 2>&1 && ! command -v apt-get >/dev/null; then
  missing+=("Git LFS (package git-lfs): https://git-lfs.com")
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

# The apt keys of mise and op come armored: gpg turns them into keyrings. Minimal images have no gpg.
if { ! command -v mise >/dev/null || $install_op; } && ! command -v gpg >/dev/null; then
  step "gnupg"
  echo "INFO: gpg is missing, installing the gnupg package to add the apt keys of mise and op"
  apt-get update -q
  apt-get install -y -q gnupg
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

if $install_op; then
  step "1password cli"
  echo "INFO: op is missing, installing it from 1Password's signed apt repository (https://developer.1password.com/docs/cli/get-started/)"
  arch=$(dpkg --print-architecture)
  curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --yes -o /usr/share/keyrings/1password-archive-keyring.gpg
  echo "deb [arch=$arch signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$arch stable main" >/etc/apt/sources.list.d/1password.list
  install -dm 755 /etc/debsig/policies/AC2D62742012EA22 /usr/share/debsig/keyrings/AC2D62742012EA22
  curl -fsSL https://downloads.1password.com/linux/debian/debsig/1password.pol -o /etc/debsig/policies/AC2D62742012EA22/1password.pol
  curl -fsSL https://downloads.1password.com/linux/keys/1password.asc | gpg --dearmor --yes -o /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg
  apt-get update -q
  apt-get install -y -q 1password-cli
fi

if ! git lfs version >/dev/null 2>&1; then
  step "git-lfs"
  echo "INFO: git-lfs is missing, installing it with apt: repos that use Git LFS need it"
  apt-get update -q
  apt-get install -y -q git-lfs
fi

step "user $user"
if ! id "$user" >/dev/null 2>&1; then
  useradd --create-home --shell /usr/sbin/nologin "$user"
fi
uid=$(id -u "$user")

step "secrets folder"
# Root writes the secrets through `sudo autopilot`; the service reads them through the group.
install -d -m 750 -o root -g "$user" /etc/autopilot/secrets /etc/autopilot/secrets/repos

step "linger"
if [ "$(loginctl show-user "$user" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$user"
fi
for _ in $(seq 20); do [ -d "/run/user/$uid" ] && break; sleep 0.5; done

home=$(getent passwd "$user" | cut -d: -f6)
# A clean environment: sudoers can keep the caller's HOME and XDG_* folders, and the rootless Docker
# setup would then write into the caller's home.
as_user() { sudo -u "$user" env -i HOME="$home" USER="$user" LOGNAME="$user" PATH="$PATH" XDG_RUNTIME_DIR="/run/user/$uid" "$@"; }

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
# Root runs this release through `sudo autopilot`, so $user, who runs the agent containers, must not be able to change it.
tools=/opt/autopilot-tools
install -d -m 755 -o root -g root "$tools"
tool_mise "$release" "$tools" install --yes
tool_mise "$release" "$tools" exec -- pnpm install --prod --frozen-lockfile --silent
node=$(tool_mise "$release" "$tools" which node)
ln -sfn "$release" /opt/autopilot

step "service"
# systemd does not start a service whose LoadCredential= file is missing.
credential=
if [ -f "$op_token" ]; then credential="LoadCredential=op-token:$op_token"; fi
unit=$(cat <<EOF
[Unit]
Description=autopilot
After=network-online.target
Wants=network-online.target

[Service]
User=$user
WorkingDirectory=/opt/autopilot
Environment=DOCKER_HOST=$docker_host
ExecStart=$node /opt/autopilot/src/cli.ts start --foreground
$credential
SyslogIdentifier=autopilot
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

step "command /usr/local/bin/autopilot"
wrapper=$(cat <<EOF
#!/bin/sh
exec $node /opt/autopilot/src/cli.ts "\$@"
EOF
)
if [ "$(cat /usr/local/bin/autopilot 2>/dev/null)" != "$wrapper" ]; then
  printf '%s\n' "$wrapper" >/usr/local/bin/autopilot.tmp
  chmod 755 /usr/local/bin/autopilot.tmp
  mv /usr/local/bin/autopilot.tmp /usr/local/bin/autopilot
fi

systemctl restart autopilot
printf '{"at":"%s","event":"host.updated","release":"%s","by":"%s"}\n' "$(date -u +%FT%TZ)" "$release" "${SUDO_USER:-root}" | systemd-cat --identifier autopilot-audit

step "cleanup"
prune_releases "$release" "$tools" "$user" /opt/autopilot-*
# Setup before v0.1.0 gave $user its own mise. $user can put links in its home, so $user removes it,
# never root. Safe to remove once every host has run this setup.
if [ -d "$home/.local/share/mise" ] && ! pgrep -u "$user" -f "$home/.local/share/mise" >/dev/null; then
  echo "INFO: removing the mise of $user, which nothing uses"
  sudo -u "$user" rm -rf -- "$home/.local/share/mise" "$home/.local/state/mise" "$home/.cache/mise"
fi
# Copies that migrations before v0.1.0 left. A copy for the same App has nothing that host.json needs,
# but it can name accounts that the host no longer watches, so setup prints them.
for copy in /etc/autopilot/host.json.before-allow /etc/autopilot/host.json.pre-3c; do
  [ -f "$copy" ] && [ -f /etc/autopilot/host.json ] || continue
  if dropped=$("$node" -e '
    const [old, now] = process.argv.slice(1).map((path) => JSON.parse(require("node:fs").readFileSync(path, "utf8")));
    if (old.app_id !== now.app_id) process.exit(1);
    console.log([...(old.installations ?? []), ...(old.allow ?? [])].filter((entry) => !now.allow.includes(entry)).join(", "));
  ' "$copy" /etc/autopilot/host.json); then
    [ -z "$dropped" ] || echo "INFO: $copy watched $dropped; to keep one, run autopilot watch <entry>"
    echo "INFO: removing $copy"
    rm -f "$copy"
  fi
done

step "done: $(systemctl is-active autopilot)"
