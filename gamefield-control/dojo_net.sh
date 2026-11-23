#!/usr/bin/env bash
# =============================================================================
# dojo_net.sh - offline network setup + shell connection for the Robotics Dojo
#
# ONE file, two ways to use it:
#
# SOURCE it (changes the current terminal; do this in every terminal running ROS):
#   source dojo_net.sh on                 find the Pi by hostname (screen.local) and join its router
#   source dojo_net.sh on 192.168.1.50    same, Pi address given by hand (if name lookup is blocked)
#   source dojo_net.sh on mypi            same, but a different hostname
#   source dojo_net.sh off                no Pi: isolated DDS domain 99, no zenoh
#
# RUN it (setup and diagnostics, never touches your current shell):
#   ./dojo_net.sh pi      run ON the Pi (as the user that should own the router)
#   ./dojo_net.sh pc      run ON the judges' PC / WSL (adds a `dojo` shortcut: `dojo on`, `dojo off`)
#   ./dojo_net.sh find    print the Pi's current IPv4 address (scans by hostname)
#   ./dojo_net.sh env     print shell exports for the Pi (what `source ... on` evals)
#   ./dojo_net.sh check   test the link from either machine
#
# Works offline: the Pi is found by hostname via mDNS, so no address is ever stored.
# Tailscale (100.64.0.0/10) addresses are always ignored. To pin a static address instead
# of using mDNS:   export DOJO_PI_IP=192.168.1.50   (or: source dojo_net.sh on 192.168.1.50)
# Sourcing clears any stale PI_IP / ZENOH_CONFIG_OVERRIDE / ZENOH_SESSION_CONFIG_URI / DOJO_SCREEN_STREAM
# (e.g. left over from ~/.bashrc) before setting anything.
#
# Options (run mode; `--host` also works as `source dojo_net.sh on --host NAME`)
#   --host NAME     the Pi's hostname              (default screen.local)
#   --user NAME     user the router runs as        (pi mode; default: you)
#   --ros-distro D  ROS distro                     (default jazzy)
#   --dry-run       print what would happen, change nothing
#   -h, --help
# =============================================================================

# -----------------------------------------------------------------------------
# SOURCED MODE: connect / disconnect THIS shell. Must come first and must never
# `exit` or `set -e`, because that would kill the user's terminal.
# -----------------------------------------------------------------------------
if (return 0 2>/dev/null); then
  _dn_self="$(readlink -f "${BASH_SOURCE[0]}")"
  _dn_repo="$(dirname "$_dn_self")"
  _dn_distro="${DOJO_ROS_DISTRO:-${ROS_DISTRO:-jazzy}}"
  _dn_mode="${1:-on}"
  _dn_rc=0
  _dn_host_args=()
  _dn_ip=""

  case "$_dn_mode" in
    on|off) ;;
    *) echo "usage: source ${BASH_SOURCE[0]} on [pi-ip | hostname | --host NAME] | off" >&2; _dn_rc=1 ;;
  esac

  if [ "$_dn_rc" = 0 ]; then
    if [ -f "/opt/ros/$_dn_distro/setup.bash" ]; then
      # shellcheck disable=SC1090
      source "/opt/ros/$_dn_distro/setup.bash"
    else
      echo "ERROR: /opt/ros/$_dn_distro/setup.bash not found (set DOJO_ROS_DISTRO?)" >&2; _dn_rc=1
    fi
  fi

  if [ "$_dn_rc" = 0 ]; then
    if [ -f "$_dn_repo/install/setup.bash" ]; then
      # shellcheck disable=SC1091
      source "$_dn_repo/install/setup.bash"
    else
      echo "NOTE: $_dn_repo/install not found yet - run 'colcon build --symlink-install' in $_dn_repo first."
    fi

    # always start clean: never inherit an address from an old shell setup
    unset PI_IP ZENOH_CONFIG_OVERRIDE ZENOH_SESSION_CONFIG_URI DOJO_SCREEN_STREAM

    if [ "$_dn_mode" = off ]; then
      unset RMW_IMPLEMENTATION
      export ROS_DOMAIN_ID=99                      # isolated, no zenoh needed
      echo "Pi OFF mode (DDS, domain 99)"
    else
      export RMW_IMPLEMENTATION=rmw_zenoh_cpp
      export ROS_DOMAIN_ID=62                      # must match the Pi

      # 2nd arg: an IPv4 (manual), "--host NAME", or a bare hostname; none = default hostname
      if [ "${2:-}" = "--host" ]; then
        _dn_host_args=(--host "${3:?--host needs a name}")
      elif [[ "${2:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
        _dn_ip="$2"
      elif [ -n "${2:-}" ]; then
        _dn_host_args=(--host "$2")
      fi

      if [ -n "$_dn_ip" ] && [[ "$_dn_ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; then
        echo "ERROR: $_dn_ip is a Tailscale address (100.64.0.0/10). Give the Pi's LAN/static IP instead." >&2
        _dn_ip=""; _dn_rc=1
      elif [ -n "$_dn_ip" ]; then
        export PI_IP="$_dn_ip"
        export ZENOH_CONFIG_OVERRIDE="connect/endpoints=[\"tcp/${PI_IP}:7447\"]"
        export DOJO_SCREEN_STREAM="http://${PI_IP}:8080/stream"
      else
        # `env` prints exports on stdout and explains problems on stderr; if the Pi
        # is not found nothing is set, so no stale address is ever used
        _dn_exports="$(bash "$_dn_self" env --ros-distro "$_dn_distro" "${_dn_host_args[@]}")" && eval "$_dn_exports"
        unset _dn_exports
      fi

      if [ -n "${PI_IP:-}" ]; then
        echo "Pi ON mode (zenoh, domain 62), Pi found at $PI_IP, router tcp/$PI_IP:7447"
      else
        echo "Pi ON mode (zenoh, domain 62) but the Pi was NOT found: no router address set (see messages above)."
        echo "  retry, or give the address by hand:  source ${BASH_SOURCE[0]} on <pi-ip>"
        _dn_rc=1
      fi
    fi

    # a ROS 2 daemon started earlier keeps the old settings; stop it so the next ros2 command starts fresh
    ros2 daemon stop >/dev/null 2>&1 || true
  fi

  unset _dn_self _dn_repo _dn_distro _dn_mode _dn_host_args _dn_ip
  _dn_ret=$_dn_rc; unset _dn_rc
  return "$_dn_ret"   # (_dn_ret is a single leftover variable; harmless)
fi

# -----------------------------------------------------------------------------
# EXECUTED MODE: everything below only runs when the file is run, not sourced
# -----------------------------------------------------------------------------
set -euo pipefail

HOST="${DOJO_PI_HOST:-screen.local}"
RUN_USER=""
ROS_DISTRO_NAME="${ROS_DISTRO:-jazzy}"
DRY=0
ZENOH_PORT=7447
STREAM_PORT=8080
API_PORT=8000
UNIT=zenohd-router
DOMAIN_ID=62
SELF="$(readlink -f "${BASH_SOURCE[0]}")"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*" >&2; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33mWARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,/^# ====.*$/{/^# ====/!s/^# \{0,1\}//p}' "$SELF" | sed '1d' >&2
  exit "${1:-0}"
}

ROLE="${1:-}"; [ $# -gt 0 ] && shift
while [ $# -gt 0 ]; do
  case "$1" in
    --host)       HOST="${2:?}"; shift 2 ;;
    --user)       RUN_USER="${2:?}"; shift 2 ;;
    --ros-distro) ROS_DISTRO_NAME="${2:?}"; shift 2 ;;
    --dry-run)    DRY=1; shift ;;
    -h|--help)    usage 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
done
case "$ROLE" in
  pi|pc|find|env|check) ;;
  on|off) die "'$ROLE' changes your current shell, so it must be sourced:  source $0 $ROLE" ;;
  ""|-h|--help) usage 1 ;;
  *) die "unknown command: $ROLE" ;;
esac
case "$HOST" in *.*) ;; *) HOST="$HOST.local" ;; esac      # "screen" -> "screen.local"

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
if [ -z "$RUN_USER" ]; then
  if [ "$(id -u)" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then RUN_USER="$SUDO_USER"; else RUN_USER="$(id -un)"; fi
fi
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6 || true)"; RUN_HOME="${RUN_HOME:-/home/$RUN_USER}"
ROS_SETUP="/opt/ros/$ROS_DISTRO_NAME/setup.bash"

run() { if [ "$DRY" = 1 ]; then printf '  [dry-run] %s\n' "$*" >&2; else "$@"; fi; }

write_root_file() {   # usage: write_root_file /path <<EOF ... EOF
  local dest="$1" content; content="$(cat)"
  if [ "$DRY" = 1 ]; then printf '  [dry-run] would write %s:\n%s\n' "$dest" "$content" | sed 's/^/    /' >&2; return; fi
  printf '%s\n' "$content" | $SUDO tee "$dest" >/dev/null
}

is_wsl()  { grep -qi microsoft /proc/version 2>/dev/null; }
tcp_ok()  { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }
is_ipv4() { [[ "${1:-}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; }

# -----------------------------------------------------------------------------
# find_pi: resolve the Pi by hostname. Tries every method available, prints the
# IPv4 address on stdout. Nothing is cached or saved.
# -----------------------------------------------------------------------------
# Tailscale hands out addresses from 100.64.0.0/10 (CGNAT). This script is for the
# local/offline network only, so those addresses are never accepted.
is_tailscale_ip() { [[ "${1:-}" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]; }
is_lan_ipv4()     { is_ipv4 "${1:-}" && ! is_tailscale_ip "$1"; }

find_pi() {
  # A pinned static address wins:  export DOJO_PI_IP=192.168.1.50
  if [ -n "${DOJO_PI_IP:-}" ]; then
    if is_lan_ipv4 "$DOJO_PI_IP"; then echo "$DOJO_PI_IP"; return 0; fi
    warn "DOJO_PI_IP='$DOJO_PI_IP' is not a usable LAN IPv4 address (Tailscale 100.x is ignored)"
  fi

  # Only the .local (mDNS) name is tried. A bare name like "screen" would be answered
  # by Tailscale MagicDNS with the 100.x address, so there is no bare-name fallback.
  local n="$HOST" ip=""
  # every address the system resolver returns, first non-Tailscale one wins
  for ip in $(getent ahostsv4 "$n" 2>/dev/null | awk '{print $1}' | awk '!seen[$0]++' || true); do
    is_lan_ipv4 "$ip" && { echo "$ip"; return 0; }
  done
  if command -v avahi-resolve-host-name >/dev/null 2>&1; then
    ip="$(avahi-resolve-host-name -4 "$n" 2>/dev/null | awk '{print $2}' || true)"
    is_lan_ipv4 "$ip" && { echo "$ip"; return 0; }
  fi
  if command -v ping >/dev/null 2>&1; then
    ip="$(ping -4 -c1 -W2 "$n" 2>/dev/null | sed -n 's/^PING [^(]*(\([0-9.]*\)).*/\1/p' | head -n1 || true)"
    is_lan_ipv4 "$ip" && { echo "$ip"; return 0; }
  fi
  if is_wsl && command -v powershell.exe >/dev/null 2>&1; then   # Windows resolves .local natively
    for ip in $(powershell.exe -NoProfile -Command "[System.Net.Dns]::GetHostAddresses('$n') | Where-Object { \$_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { \$_.IPAddressToString }" 2>/dev/null | tr -d '\r' || true); do
      is_lan_ipv4 "$ip" && { echo "$ip"; return 0; }
    done
  fi
  return 1
}

find_or_explain() {
  local ip
  if ip="$(find_pi)"; then echo "$ip"; return 0; fi
  warn "could not find '$HOST' on this network. Check that:"
  warn "  - the Pi is powered and on the same Wi-Fi/Ethernet as this machine"
  warn "  - the Pi runs avahi-daemon   (sudo systemctl status avahi-daemon)"
  warn "  - this machine can resolve .local names   (Linux/WSL: libnss-mdns or avahi-utils; Windows does it natively)"
  warn "  - the Pi's hostname really is '${HOST%.local}'   (run 'hostname' on the Pi)"
  return 1
}

# =============================================================================
# PI
# =============================================================================
role_pi() {
  log "Pi setup: router service runs as '$RUN_USER', ROS $ROS_DISTRO_NAME, announced as $HOST"

  if [ -f "$ROS_SETUP" ] && bash -c "source '$ROS_SETUP' && ros2 pkg prefix rmw_zenoh_cpp" >/dev/null 2>&1; then
    ok "rmw_zenoh_cpp found"
  else
    local m="rmw_zenoh_cpp not found for ROS $ROS_DISTRO_NAME. Install it once while online:  sudo apt install ros-$ROS_DISTRO_NAME-rmw-zenoh-cpp"
    if [ "$DRY" = 1 ]; then warn "$m"; else die "$m"; fi
  fi

  # --- hostname announcement (mDNS) -----------------------------------------
  local short="${HOST%.local}"
  if [ "$(hostname -s 2>/dev/null)" != "$short" ]; then
    warn "this Pi's hostname is '$(hostname -s)', not '$short'. To rename it:  sudo hostnamectl set-hostname $short"
  else
    ok "hostname is '$short'"
  fi
  if systemctl list-unit-files avahi-daemon.service 2>/dev/null | grep -q '^avahi-daemon'; then
    run $SUDO systemctl enable --now avahi-daemon.service
    ok "avahi-daemon running: the Pi answers to $HOST without internet or DNS"
  else
    local m="avahi-daemon is not installed, so $HOST cannot be found. Install once while online:  sudo apt install avahi-daemon"
    if [ "$DRY" = 1 ]; then warn "$m"; else die "$m"; fi
  fi

  # --- router service --------------------------------------------------------
  local f="/etc/systemd/system/$UNIT.service"
  log "Writing $f (native rmw router, no config file)"
  if [ -f "$f" ] && [ "$DRY" != 1 ]; then
    $SUDO cp -a "$f" "$f.bak.$(date +%Y%m%d-%H%M%S)"; ok "old unit backed up next to it (.bak.*)"
  fi
  # After=network.target, not network-online.target: the router binds to all
  # addresses and must not wait for (or fail on) a missing internet link.
  write_root_file "$f" <<EOF
[Unit]
Description=Zenoh Router (native rmw_zenoh_cpp router)
After=network.target
Wants=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=$RUN_USER
Environment="HOME=$RUN_HOME"
ExecStart=/bin/bash -c "source $ROS_SETUP && exec ros2 run rmw_zenoh_cpp rmw_zenohd"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

  if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    log "ufw is active: opening Zenoh ($ZENOH_PORT) and the screen stream ($STREAM_PORT)"
    run $SUDO ufw allow "$ZENOH_PORT/tcp"
    run $SUDO ufw allow "$STREAM_PORT/tcp"
  fi

  log "Restarting the router, then everything that depends on it"
  run $SUDO systemctl daemon-reload
  run $SUDO systemctl enable "$UNIT.service"
  run $SUDO systemctl restart "$UNIT.service"
  local u
  for u in screen_manager screen_stream loading_station gamefield_barrier; do
    if systemctl list-unit-files "$u.service" 2>/dev/null | grep -q "^$u.service"; then
      run $SUDO systemctl restart "$u.service"
    fi
  done

  if [ "$DRY" != 1 ]; then
    for _ in 1 2 3 4 5 6 7 8 9 10; do ss -ltnH 2>/dev/null | grep -q ":$ZENOH_PORT " && break; sleep 1; done
    if ss -ltnH 2>/dev/null | grep -q ":$ZENOH_PORT "; then ok "router listening on :$ZENOH_PORT"
    else bad "nothing listening on :$ZENOH_PORT - see: journalctl -u $UNIT -n 50"; fi
  fi

  cat >&2 <<EOF

Pi done. It is reachable as $HOST; nothing else to configure.
(The old zenoh_config.json5 is no longer used; it was left where it was.)
Next, on the PC:  ./dojo_net.sh pc     then     ./dojo_net.sh check
EOF
}

# =============================================================================
# PC
# =============================================================================
role_pc() {
  log "PC setup (looking for $HOST)"
  local ip=""
  if ip="$(find_or_explain)"; then ok "found $HOST at $ip right now (not saved)"
  else warn "continuing anyway; 'source dojo_net.sh on' looks again every time you use it"; fi

  # The helper stores only this script's path, never an address. It is a plain
  # shell function, so `dojo on` / `dojo off` run the sourced mode in your shell.
  local envf="$RUN_HOME/.dojo_net.env"
  log "Writing $envf"
  local body
  body="$(cat <<EOF
# written by dojo_net.sh. Holds no IP address: 'on' scans for the Pi each time.
#   dojo on [pi-ip|hostname]     connect this terminal to the Pi
#   dojo off                     isolated, no Pi
dojo() { source '$SELF' "\$@"; }
EOF
)"
  if [ "$DRY" = 1 ]; then printf '%s\n' "$body" | sed 's/^/    /' >&2
  else
    printf '%s\n' "$body" > "$envf"
    local bashrc="$RUN_HOME/.bashrc" mark="# dojo_net.sh"
    if [ -f "$bashrc" ] && ! grep -qF "$mark" "$bashrc"; then
      printf '\n%s\n[ -f ~/.dojo_net.env ] && source ~/.dojo_net.env\n' "$mark" >> "$bashrc"
      ok "~/.bashrc now defines 'dojo' in every new terminal"
    fi
  fi

  if is_wsl; then
    cat >&2 <<EOF

WSL note: finding the Pi works from inside WSL (it falls back to Windows' own name lookup).
Only if teams must reach the judges' page / /team on port $API_PORT, do this once on Windows
(PowerShell as Administrator), then run 'wsl --shutdown':
    Add-Content "\$env:USERPROFILE\\.wslconfig" "[wsl2]\`nnetworkingMode=mirrored"
    New-NetFirewallRule -DisplayName "Dojo web $API_PORT" -Direction Inbound -Protocol TCP -LocalPort $API_PORT -Action Allow
EOF
  fi

  cat >&2 <<EOF

PC done. In each new terminal that talks to the Pi:
    dojo on                  (or: source $SELF on)
    ros2 run web_pi_bridge fastapi_node
EOF
}

# =============================================================================
# FIND / ENV  (stdout is machine-readable: only the result goes there)
# =============================================================================
cmd_find() { find_or_explain; }

cmd_env() {
  local ip; ip="$(find_or_explain)" || exit 1
  cat <<EOF
export PI_IP='$ip'
export RMW_IMPLEMENTATION=rmw_zenoh_cpp
export ROS_DOMAIN_ID=$DOMAIN_ID
export ZENOH_CONFIG_OVERRIDE='connect/endpoints=["tcp/$ip:$ZENOH_PORT"]'
export DOJO_SCREEN_STREAM='http://$ip:$STREAM_PORT/stream'
EOF
}

# =============================================================================
# CHECK
# =============================================================================
role_check() {
  local fails=0
  if [ "$(hostname -s 2>/dev/null)" = "${HOST%.local}" ]; then
    log "Checking (running on the Pi, $HOST)"
    systemctl is-active --quiet "$UNIT" && ok "$UNIT.service active" || { bad "$UNIT.service not active"; fails=1; }
    ss -ltnH 2>/dev/null | grep -q ":$ZENOH_PORT " && ok "router listening on :$ZENOH_PORT" || { bad "router not listening on :$ZENOH_PORT"; fails=1; }
    ss -ltnH 2>/dev/null | grep -q ":$STREAM_PORT " && ok "screen stream listening on :$STREAM_PORT" || { bad "screen stream not on :$STREAM_PORT (screen_stream.service?)"; fails=1; }
    systemctl is-active --quiet avahi-daemon && ok "avahi-daemon active ($HOST is announced)" || { bad "avahi-daemon not active: $HOST will not be found"; fails=1; }
  else
    log "Checking (running on the PC, looking for $HOST)"
    local ip
    if ip="$(find_pi)"; then ok "found $HOST -> $ip"; else bad "cannot find $HOST (see hints from: $0 find)"; exit 1; fi
    tcp_ok "$ip" "$ZENOH_PORT"  && ok "Zenoh router reachable   tcp/$ip:$ZENOH_PORT"  || { bad "cannot reach tcp/$ip:$ZENOH_PORT (router down or firewall)"; fails=1; }
    tcp_ok "$ip" "$STREAM_PORT" && ok "screen stream reachable  tcp/$ip:$STREAM_PORT" || { bad "cannot reach tcp/$ip:$STREAM_PORT"; fails=1; }
    if [ -f "$ROS_SETUP" ] && command -v timeout >/dev/null 2>&1; then
      log "ROS graph through Zenoh (10 s)"
      local out
      out="$(bash -c "source '$ROS_SETUP'
                      unset ZENOH_SESSION_CONFIG_URI
                      export RMW_IMPLEMENTATION=rmw_zenoh_cpp ROS_DOMAIN_ID=$DOMAIN_ID
                      export ZENOH_CONFIG_OVERRIDE='connect/endpoints=[\"tcp/$ip:$ZENOH_PORT\"]'
                      timeout 10 ros2 service list --no-daemon 2>/dev/null" || true)"
      if grep -q screen_manager_node <<<"$out"; then ok "screen_manager_node visible from the PC"
      else bad "screen_manager_node not seen (is screen_manager.service running on the Pi?)"; fails=1; fi
    fi
  fi
  if [ $fails = 0 ]; then log "All good."; else warn "some checks failed"; exit 1; fi
}

case "$ROLE" in
  pi)    role_pi ;;
  pc)    role_pc ;;
  find)  cmd_find ;;
  env)   cmd_env ;;
  check) role_check ;;
esac