#!/usr/bin/env bash
# agentq.md § 5 service lifecycle on a disposable CI runner: install, status, restart, stop, uninstall.
# The OS unit does not carry AGENTQ_INSTALL, so this uses the default install of the runner's user.
set -euo pipefail
bin=$1
case "$(uname -s)" in
  MINGW* | MSYS*)
    install="$(cygpath "$LOCALAPPDATA")/agentq"
    alive() { tasklist //FI "PID eq $1" //NH | grep -qw "$1"; }
    ;;
  Linux)
    # GitHub runners have no user systemd until the user lingers
    sudo loginctl enable-linger "$USER"
    export XDG_RUNTIME_DIR="/run/user/$(id -u)"
    for _ in $(seq 30); do [ -S "$XDG_RUNTIME_DIR/bus" ] && break; sleep 1; done
    install="$HOME/.local/share/agentq"
    alive() { kill -0 "$1" 2>/dev/null; }
    ;;
  *)
    install="$HOME/.local/share/agentq"
    alive() { kill -0 "$1" 2>/dev/null; }
    ;;
esac
status="$install/status.json"

pid() { sed -n 's/.*"pid": *\([0-9]*\).*/\1/p' "$status" 2>/dev/null; }

# a live service pid other than $1, from a fresh status.json
started() {
  for _ in $(seq 60); do
    p=$(pid)
    if [ -n "$p" ] && [ "$p" != "$1" ] && alive "$p"; then echo "$p"; return; fi
    sleep 2
  done
  echo "no new service pid after $1" >&2
  cat "$install"/*.log >&2 || true
  exit 1
}

gone() {
  for _ in $(seq 30); do alive "$1" || return 0; sleep 1; done
  echo "pid $1 still running" >&2
  exit 1
}

"$bin" service install
# Installation must expose the command outside its folder in a refreshed user environment.
case "$(uname -s)" in
  MINGW* | MSYS*)
    powershell.exe -NoProfile -NonInteractive -Command '$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User"); Set-Location $env:TEMP; agentq --version; if ($LASTEXITCODE -ne 0) { exit 1 }'
    ;;
  *)
    (cd /; env PATH=/usr/bin:/bin bash -lc 'agentq --version')
    ;;
esac
p1=$(started none)
"$bin" service status
"$bin" service restart
p2=$(started "$p1")
gone "$p1"
"$bin" service status
"$bin" service stop
gone "$p2"
"$bin" service uninstall
"$bin" service uninstall
gone "$p2"
"$bin" uninstall
"$bin" uninstall
if [ -L "$HOME/.local/bin/agentq" ]; then echo 'command link survived uninstall' >&2; exit 1; fi
echo "service lifecycle: ok ($p1, $p2)"
