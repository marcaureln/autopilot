# shellcheck shell=bash

step() { printf '==> %s\n' "$*"; }

tool_mise() {
  local release=$1 tools=$2
  shift 2
  env MISE_DATA_DIR="$tools" MISE_TRUSTED_CONFIG_PATHS="$release" mise --cd "$release" "$@"
}

# Keeps the current release and the newest other one that the user who runs setup owns. Releases of
# the service user come from setup before v0.1.0. That user can write into them, so the user empties
# them and root removes only the empty folder. Safe to remove once every host has run this setup.
prune_releases() {
  local current=$1 tools=$2 service_user=$3 dir previous=""
  shift 3
  { ls -dt "$@" 2>/dev/null || true; } | while read -r dir; do
    case "$dir" in "$current" | "$tools" | *.tmp) continue ;; esac
    [ -d "$dir" ] && [ ! -L "$dir" ] || continue
    if [ -O "$dir" ]; then
      if [ -z "$previous" ]; then
        previous=$dir
        continue
      fi
      echo "INFO: removing the old release $dir"
      rm -rf -- "$dir"
    elif [ -n "$service_user" ] && [ "$(stat -c %U "$dir")" = "$service_user" ]; then
      echo "INFO: removing the old release $dir of $service_user"
      # find returns to the folder it started in, which the service user may not be able to read.
      (cd / && sudo -u "$service_user" find "$dir" -mindepth 1 -delete)
      rmdir -- "$dir"
    fi
  done
}
