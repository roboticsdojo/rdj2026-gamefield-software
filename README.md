# rdj2026-gamefield-software
The pi 4 of the gamefield connects to the following network:
SSID: gamenet
Password: space_metal_welding!

## NETWORK CONFIGURATION
All ROS terminals need ROS_DOMAIN_ID=62 and RMW_IMPLEMENTATION=rmw_zenoh_cpp

### Services
1. Router startup service
Lives on the pi
```(/etc/systemd/system/zenohd-router.service
[Unit]
Description=Zenoh Router (native rmw_zenoh_cpp router)
After=network.target
Wants=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=screen
Environment="HOME=/home/screen"
ExecStart=/bin/bash -c "source /opt/ros/jazzy/setup.bash && exec ros2 run rmw_zenoh_cpp rmw_zenohd"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```
**Service check**
```
sudo systemctl daemon-reload
sudo systemctl enable zenohd-router.service
sudo systemctl restart zenohd-router.service
sudo systemctl status zenohd-router.service
```
Bash script that syncs networks (dojo_net.sh)
```
#!/usr/bin/env bash
# =============================================================================
# dojo_net.sh - offline network setup for the Robotics Dojo gamefield
#
# No internet, no Tailscale, no fixed IP addresses. The PC finds the Pi by its
# hostname (default screen.local, via mDNS) every time, so nothing about the
# Pi's address is ever stored.
#
#   ./dojo_net.sh pi      run ON the Pi (as the user that should own the router)
#   ./dojo_net.sh pc      run ON the judges' PC / WSL
#   ./dojo_net.sh find    print the Pi's current IPv4 address (scans by hostname)
#   ./dojo_net.sh env     print shell exports for talking to the Pi:
#                             eval "$(./dojo_net.sh env)"
#   ./dojo_net.sh check   test the link from either machine
#
# Options
#   --host NAME     the Pi's hostname            (default screen.local)
#   --user NAME     Linux user the router runs as (pi mode; default: you)
#   --ros-distro D  ROS distro                    (default jazzy)
#   --dry-run       print what would happen, change nothing
#   -h, --help
# =============================================================================
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
  cat <<'EOF'
dojo_net.sh - offline network setup for the Robotics Dojo gamefield

  ./dojo_net.sh pi      run ON the Pi (as the user that should own the router)
  ./dojo_net.sh pc      run ON the judges' PC / WSL
  ./dojo_net.sh find    print the Pi's current IPv4 address (scans by hostname)
  ./dojo_net.sh env     print shell exports:  eval "$(./dojo_net.sh env)"
  ./dojo_net.sh check   test the link from either machine

  --host NAME     the Pi's hostname             (default screen.local)
  --user NAME     user the router runs as       (pi mode; default: you)
  --ros-distro D  ROS distro                    (default jazzy)
  --dry-run       print what would happen, change nothing
EOF
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
case "$ROLE" in pi|pc|find|env|check) ;; ""|-h|--help) usage 1 ;; *) die "unknown command: $ROLE" ;; esac
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
find_pi() {
  local names=("$HOST") ip="" n
  [[ "$HOST" == *.local ]] && names+=("${HOST%.local}")      # plain name also works on routers that register hosts
  for n in "${names[@]}"; do
    ip="$(getent ahostsv4 "$n" 2>/dev/null | awk 'NR==1{print $1}' || true)"
    is_ipv4 "$ip" && { echo "$ip"; return 0; }
    if command -v avahi-resolve-host-name >/dev/null 2>&1; then
      ip="$(avahi-resolve-host-name -4 "$n" 2>/dev/null | awk '{print $2}' || true)"
      is_ipv4 "$ip" && { echo "$ip"; return 0; }
    fi
    if command -v ping >/dev/null 2>&1; then
      ip="$(ping -4 -c1 -W2 "$n" 2>/dev/null | sed -n 's/^PING [^(]*(\([0-9.]*\)).*/\1/p' | head -n1 || true)"
      is_ipv4 "$ip" && { echo "$ip"; return 0; }
    fi
    if is_wsl && command -v powershell.exe >/dev/null 2>&1; then   # Windows resolves .local natively
      ip="$(powershell.exe -NoProfile -Command "[System.Net.Dns]::GetHostAddresses('$n') | Where-Object { \$_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { \$_.IPAddressToString }" 2>/dev/null | tr -d '\r' | head -n1 || true)"
      is_ipv4 "$ip" && { echo "$ip"; return 0; }
    fi
  done
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
  for u in screen_manager screen_stream loading_station; do
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
  else warn "continuing anyway; the shell helper below looks again every time you use it"; fi

  # The helper stores the SCRIPT'S PATH and the hostname, never an address.
  local envf="$RUN_HOME/.dojo_net.env"
  log "Writing $envf"
  local body
  body="$(cat <<EOF
# written by dojo_net.sh. Holds no IP address: dojo_net_up scans for $HOST each time.
dojo_net_up() {
  local out
  out="\$('$SELF' env --host '$HOST' --ros-distro '$ROS_DISTRO_NAME')" || return 1
  eval "\$out"
  echo "Pi found at \$PI_IP  (Zenoh: \$ZENOH_CONFIG_OVERRIDE)"
}
EOF
)"
  if [ "$DRY" = 1 ]; then printf '%s\n' "$body" | sed 's/^/    /' >&2
  else
    printf '%s\n' "$body" > "$envf"
    local bashrc="$RUN_HOME/.bashrc" mark="# dojo_net.sh"
    if [ -f "$bashrc" ] && ! grep -qF "$mark" "$bashrc"; then
      printf '\n%s\n[ -f ~/.dojo_net.env ] && source ~/.dojo_net.env\n' "$mark" >> "$bashrc"
      ok "~/.bashrc now defines dojo_net_up in every new terminal"
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

PC done. In each terminal that talks to the Pi:
    dojo_net_up                  # scans for $HOST, sets PI_IP, ZENOH_CONFIG_OVERRIDE, DOJO_SCREEN_STREAM
    source dojo_env.sh on
    ros2 run web_pi_bridge fastapi_node
(open a new terminal first, or: source ~/.dojo_net.env)
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
```

## MAIN DASHBOARD
All files live in the web_pi_bridge package that includes the FastAPI app and the html/css/js files for the webpage
### CODE FILES
- fastapi_node.py: One FastAPI app on port 8000. It runs two ROS clients: screen (/api/set_display*) and dispenser (/api/dispenser/*). It also holds the map and detection exchange (/api/maps/*) and the teams and scoreboard (/api/competition/*, saved to ~/dojo_maps/competition.json)


## GAMEFIELD SCREEN INTEGRATION
Model: Waveshare 7 inch display-c 1024x600 pixel mpi7002 v2.0 
### SERVICES
1. screen_manager.service
```
[Unit]
Description=ROS 2 Screen Manager Node
After=local-fs.target zenohd-router.service
Wants=zenohd-router.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=screen
Group=video
Environment="HOME=/home/screen"
Environment="USER=screen"
Environment="PYTHONUNBUFFERED=1"
Environment="ROS_DOMAIN_ID=62"
Environment="RMW_IMPLEMENTATION=rmw_zenoh_cpp"
ExecStartPre=/bin/sleep 2
ExecStart=/bin/bash -c "source /opt/ros/jazzy/setup.bash && source /home/screen/ros2_ws/install/setup.bash && ros2 run screen_images screen_manager_node"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```
2. screen_stream.service
```/etc/systemd/system/screen_stream.service
[Unit]
Description=ROS2 Screen Stream Node
After=screen_manager.service
Wants=screen_manager.service

[Service]
Type=simple
User=screen
Group=video
Environment="HOME=/home/screen"
ExecStartPre=/bin/sleep 2
ExecStart=/bin/bash -c "source /opt/ros/jazzy/setup.bash && source /home/screen/ros2_ws/install/setup.bash && ros2 run screen_images stream_node"
Restart=always
RestartSec=3
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
```
**service management**
```
sudo systemctl daemon-reload
sudo systemctl enable screen_manager.service
sudo systemctl start screen_manager.service
sudo systemctl status screen_manager.service
```

### CODE FILES
1. screen_images package
Contains the logos as well as images in three classes:
- screen_manager_node.py: Scans test_images/<category>/ and writes images to /dev/fb0 as RGB565, hardcoded at 1024×600. It starts on the logo. It offers ~/set_display_class (random image from a category), the legacy ~/set_display (SetBool) and a ~/display_command topic.
- stream_node.py: Plain Python with no ROS. It reads /dev/fb0 and serves MJPEG on port 8080 at about 20 fps.

2. screen_interfaces
- SetDisplayClass.srv: Request category; response success and message. It’s shared by the Pi and the laptop.

### Manual override 
Reads touch events directly and draws to framebuffer. Hold for 2 seconds: returns to the idle logo Hold for 2 seconds: returns to the idle logo (--hold changes the time, and 0 turns it off)
```touch_override.py
#!/usr/bin/env python3
"""Manual touch override for the gamefield screen (Waveshare 7inch HDMI LCD (C), 1024x600).

Touch the screen and it shows a random image from a random class (organic / metal /
plastic ...). Hold your finger down for --hold seconds (default 2) to go back to the
idle logo. It writes straight to /dev/fb0, exactly like screen_manager_node, so it
works with ROS, Zenoh and the network all switched off. Whoever wrote last wins: the
judges' page, or a tap on the screen.

No ROS and no extra pip packages: only numpy and Pillow (already needed by
screen_images). The touch panel is read from /dev/input/eventN.

Run on the Pi (user needs the 'video' group for /dev/fb0 and 'input' for the touch):
    python3 touch_override.py                     # all classes
    python3 touch_override.py --classes organic   # only that class (comma list allowed)
    python3 touch_override.py --list              # show input devices and found images
    python3 touch_override.py --once              # show one random image now, no touch needed
    python3 touch_override.py --print-service     # systemd unit text, see below

Run as a service (same pattern as screen_manager.service):
    python3 touch_override.py --print-service | sudo tee /etc/systemd/system/touch_override.service
    sudo systemctl daemon-reload && sudo systemctl enable --now touch_override.service
Optional: to run it as 'ros2 run screen_images touch_override', copy this file into the
screen_images package and add to setup.py console_scripts:
    'touch_override = screen_images.touch_override:main'
"""
import argparse
import errno
import fcntl
import os
import random
import re
import select
import signal
import struct
import sys
import time

import numpy as np
from PIL import Image, ImageOps

EV_KEY, EV_ABS = 0x01, 0x03
BTN_TOUCH = 0x14A
ABS_MT_TRACKING_ID = 0x39
EVIOCGRAB = 0x40044590
EVENT = struct.Struct('llHHi')               # struct input_event: time (2 longs), type, code, value
IMAGE_EXTS = ('.png', '.jpg', '.jpeg')
DEFAULT_NAME_RE = r'waveshare|touch|egalax|goodix|ft5'

_running = True


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- images
def find_images_root(explicit):
    cands = []
    if explicit:
        cands.append(explicit)
    if os.environ.get('SCREEN_IMAGES_DIR'):
        cands.append(os.environ['SCREEN_IMAGES_DIR'])
    try:
        from ament_index_python.packages import get_package_share_directory
        cands.append(os.path.join(get_package_share_directory('screen_images'), 'test_images'))
    except Exception:
        pass
    here = os.path.dirname(os.path.realpath(__file__))
    cands += [
        os.path.join(here, 'test_images'),
        os.path.join(here, '..', 'test_images'),
        os.path.join(here, '..', 'screen_images', 'test_images'),
        os.path.expanduser('~/ros2_ws/install/screen_images/share/screen_images/test_images'),
    ]
    for c in cands:
        c = os.path.realpath(os.path.expanduser(c))
        if load_classes(c):
            return c
    sys.exit('No images found. Pass --images DIR (a folder holding one sub-folder per class).')


def load_classes(root):
    classes = {}
    if not os.path.isdir(root):
        return classes
    for entry in sorted(os.listdir(root)):
        d = os.path.join(root, entry)
        if os.path.isdir(d):
            files = [os.path.join(d, f) for f in sorted(os.listdir(d)) if f.lower().endswith(IMAGE_EXTS)]
            if files:
                classes[entry] = files
    return classes


# ------------------------------------------------------------------------ framebuffer
def _sysfs(fb_path, name):
    try:
        with open(f'/sys/class/graphics/{os.path.basename(fb_path)}/{name}') as f:
            return f.read().strip()
    except OSError:
        return None


class Framebuffer:
    """Writes a picture, centre-cropped to fill the screen (never stretched), to /dev/fbN."""

    def __init__(self, path, width, height):
        self.path, self.w, self.h = path, width, height
        bpp = _sysfs(path, 'bits_per_pixel')
        self.bpp = int(bpp) if bpp else 16
        if self.bpp not in (16, 32):
            sys.exit(f'Unsupported framebuffer depth: {self.bpp} bpp (need 16 or 32).')
        stride = _sysfs(path, 'stride')
        self.stride = int(stride) if stride else self.w * self.bpp // 8
        if self.stride < self.w * self.bpp // 8:
            sys.exit(f'Framebuffer stride {self.stride} is smaller than {self.w} px at {self.bpp} bpp.')
        vs = _sysfs(path, 'virtual_size')
        if vs and int(vs.split(',')[0]) != self.w:
            log(f"WARNING: {path} is {vs.replace(',', 'x')} but --size is {self.w}x{self.h}")

    def show(self, img_path):
        try:
            img = Image.open(img_path).convert('RGB')
            img = ImageOps.fit(img, (self.w, self.h), centering=(0.5, 0.5))
            a = np.asarray(img, dtype=np.uint8)
            if self.bpp == 16:                                   # RGB565, same as screen_manager_node
                px = ((a[:, :, 0].astype(np.uint16) >> 3) << 11) | \
                     ((a[:, :, 1].astype(np.uint16) >> 2) << 5) | \
                     (a[:, :, 2].astype(np.uint16) >> 3)
                out = np.zeros((self.h, self.stride // 2), dtype='<u2')
                out[:, :self.w] = px
            else:                                                # 32 bpp: B, G, R, X
                out = np.zeros((self.h, self.stride // 4, 4), dtype=np.uint8)
                out[:, :self.w, 0], out[:, :self.w, 1], out[:, :self.w, 2] = a[:, :, 2], a[:, :, 1], a[:, :, 0]
                out[:, :self.w, 3] = 255
            with open(self.path, 'wb') as fb:
                fb.write(out.tobytes())
            return True
        except Exception as e:
            log(f'ERROR drawing {img_path}: {e}')
            return False


# ------------------------------------------------------------------------- touch input
def _has_bit(words, n):
    """Test bit n of a /proc/bus/input/devices bitmap (hex words, most significant first)."""
    wb = struct.calcsize('l') * 8
    idx = n // wb
    if idx >= len(words):
        return False
    try:
        return bool((int(words[-1 - idx], 16) >> (n % wb)) & 1)
    except ValueError:
        return False


def list_input_devices():
    devs, cur = [], {}
    try:
        with open('/proc/bus/input/devices') as f:
            lines = f.read().splitlines()
    except OSError:
        return devs
    for line in lines + ['']:
        if not line.strip():
            if cur.get('event'):
                devs.append(cur)
            cur = {}
        elif line.startswith('N: Name='):
            cur['name'] = line.split('=', 1)[1].strip().strip('"')
        elif line.startswith('H: Handlers='):
            m = re.search(r'event(\d+)', line)
            cur['event'] = f'/dev/input/event{m.group(1)}' if m else None
        elif line.startswith('B: KEY='):
            cur['touch_btn'] = _has_bit(line.split('=', 1)[1].split(), BTN_TOUCH)
        elif line.startswith('B: ABS='):
            cur['abs'] = True
    return devs


def find_touch_device(name_re):
    pat = re.compile(name_re, re.I)
    best = []
    for d in list_input_devices():
        by_name = bool(pat.search(d.get('name', '')))
        capable = d.get('touch_btn') and d.get('abs')
        if by_name or capable:
            best.append((0 if by_name else 1, d))
    best.sort(key=lambda t: t[0])
    return best[0][1] if best else None


# ------------------------------------------------------------------------------ logic
class Override:
    def __init__(self, fb, classes, logo, only):
        self.fb, self.classes, self.logo = fb, classes, logo
        self.pool = [c for c in classes if (not only or c in only)]
        self.last = None

    def random_image(self):
        cls = random.choice(self.pool)
        files = self.classes[cls]
        choices = [f for f in files if f != self.last] or files     # never the same picture twice in a row
        img = random.choice(choices)
        self.last = img
        return cls, img

    def show_random(self):
        cls, img = self.random_image()
        if self.fb.show(img):
            log(f"tap -> class '{cls}': {os.path.basename(img)}")

    def show_logo(self):
        if self.logo and self.fb.show(self.logo):
            log('hold -> idle logo')
            self.last = None


def watch(dev_path, ov, cooldown, hold_s, grab):
    """Read touch events from one device until it disappears. Returns normally on unplug."""
    fd = os.open(dev_path, os.O_RDONLY | os.O_NONBLOCK)
    if grab:
        try:
            fcntl.ioctl(fd, EVIOCGRAB, 1)
        except OSError as e:
            log(f'could not grab {dev_path}: {e}')
    down, down_t, hold_done, last_fire, buf = False, 0.0, False, 0.0, b''
    try:
        while _running:
            ready, _, _ = select.select([fd], [], [], 0.1)
            if ready:
                try:
                    data = os.read(fd, EVENT.size * 64)
                except BlockingIOError:
                    data = None
                except OSError as e:
                    if e.errno == errno.ENODEV:
                        log('touch device unplugged')
                        return
                    raise
                if data == b'':
                    log('touch device closed')
                    return
                if data:
                    buf += data
                while len(buf) >= EVENT.size:
                    _, _, etype, code, value = EVENT.unpack(buf[:EVENT.size])
                    buf = buf[EVENT.size:]
                    state = None
                    if etype == EV_KEY and code == BTN_TOUCH and value in (0, 1):
                        state = bool(value)
                    elif etype == EV_ABS and code == ABS_MT_TRACKING_ID:
                        state = value != -1
                    if state is True and not down:
                        down, down_t, hold_done = True, time.monotonic(), False
                        if down_t - last_fire >= cooldown:
                            last_fire = down_t
                            ov.show_random()
                    elif state is False and down:
                        down = False
            if down and hold_s > 0 and not hold_done and time.monotonic() - down_t >= hold_s:
                hold_done = True
                ov.show_logo()
    finally:
        os.close(fd)


def service_text(script, images_root, user):
    return f"""[Unit]
Description=Gamefield screen touch override
After=local-fs.target

[Service]
Type=simple
User={user}
Group=video
SupplementaryGroups=input
Environment="PYTHONUNBUFFERED=1"
ExecStart=/usr/bin/python3 {script} --images {images_root}
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
"""


def main(argv=None):
    global _running
    ap = argparse.ArgumentParser(description='Tap the gamefield screen to show a random image from a random class.')
    ap.add_argument('--classes', default='', help='comma list to draw from (default: every class found)')
    ap.add_argument('--images', default='', help='folder with one sub-folder of images per class')
    ap.add_argument('--device', default='', help='touch device, e.g. /dev/input/event3 (default: auto-detect)')
    ap.add_argument('--name', default=DEFAULT_NAME_RE, help='regex for the touch device name when auto-detecting')
    ap.add_argument('--fb', default='/dev/fb0')
    ap.add_argument('--size', default='1024x600', help='screen size WxH (Waveshare 7inch (C): 1024x600)')
    ap.add_argument('--cooldown', type=float, default=0.5, help='ignore taps closer together than this many seconds')
    ap.add_argument('--hold', type=float, default=2.0, help='hold this long to show the logo; 0 disables')
    ap.add_argument('--grab', action='store_true', help='take exclusive control of the touch device')
    ap.add_argument('--once', action='store_true', help='show one random image and exit (no touch needed)')
    ap.add_argument('--list', action='store_true', help='list input devices and images, then exit')
    ap.add_argument('--print-service', action='store_true', help='print a systemd unit and exit')
    a = ap.parse_args(argv)

    try:
        w, h = (int(v) for v in a.size.lower().split('x'))
    except ValueError:
        sys.exit('--size must look like 1024x600')

    root = find_images_root(a.images)
    classes = load_classes(root)
    only = [c.strip() for c in a.classes.split(',') if c.strip()]
    unknown = [c for c in only if c not in classes]
    if unknown:
        sys.exit(f"Unknown class {unknown}. Available: {list(classes)}")
    logo = os.path.join(os.path.dirname(root), 'logos', 'icon.png')
    logo = logo if os.path.exists(logo) else None

    if a.print_service:
        sys.stdout.write(service_text(os.path.realpath(__file__), root, os.environ.get('SUDO_USER') or os.environ.get('USER', 'screen')))
        return
    if a.list:
        print(f'images: {root}')
        for c, f in classes.items():
            print(f'  {c}: {len(f)} images')
        print('input devices:')
        for d in list_input_devices():
            flag = ' <- touch' if d.get('touch_btn') and d.get('abs') else ''
            print(f"  {d['event']}  {d.get('name', '?')}{flag}")
        return

    fb = Framebuffer(a.fb, w, h)
    ov = Override(fb, classes, logo, only)

    if a.once:
        ov.show_random()
        return

    def stop(*_):
        global _running
        _running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    log(f"classes: { {c: len(f) for c, f in classes.items() if not only or c in only} }  images: {root}")
    waiting_logged = False
    while _running:
        dev = {'event': a.device, 'name': 'given'} if a.device else find_touch_device(a.name)
        if not dev or not os.path.exists(dev['event']):
            if not waiting_logged:
                log('no touch device found yet (is the USB touch cable plugged in?); retrying...')
                waiting_logged = True
            time.sleep(2)
            continue
        waiting_logged = False
        log(f"touch device: {dev['event']} ({dev.get('name', '?')})   tap = random image, hold {a.hold:g}s = logo")
        try:
            watch(dev['event'], ov, a.cooldown, a.hold, a.grab)
            time.sleep(1)                                   # unplugged: pause, then look for it again
        except PermissionError:
            log(f"no permission to read {dev['event']}: add the user to the 'input' group "
                f"(sudo usermod -aG input $USER, then log in again)")
            time.sleep(5)
        except OSError as e:
            log(f'touch device error: {e}')
            time.sleep(2)
    log('stopped')


if __name__ == '__main__':
    main()
```

Copy it to the Pi and check the user can read the touch panel and write the screen:
```
groups                                              # must include: video input   (fix: sudo usermod -aG video,input screen, then log in again)
```

**One-off terminal commands**
Show a random image from a class (service call)
```
ros2 service call /screen_manager_node/set_display_class screen_interfaces/srv/SetDisplayClass "{category: 'other'}"
```
The reply says which file was shown. A wrong class name returns success=False and lists the available classes.
Random image from a random class
```
CLASS=$(shuf -n1 -e organic metal plastic)
ros2 service call /screen_manager_node/set_display_class screen_interfaces/srv/SetDisplayClass "{category: '$CLASS'}"
```
Back to the idle logo
```
ros2 service call /screen_manager_node/set_display example_interfaces/srv/SetBool "{data: false}"
```
## Quick checks
```
sudo systemctl status zenohd-router screen_manager screen_stream
journalctl -u screen_manager -n 30 --no-pager        # startup line lists the classes it found
ros2 service list -t | grep screen_manager
curl -sI http://screen.local:8080 | head -1          # stream answers
```

## Troubleshooting
Run these in the same terminal that starts fastapi_node
```
echo $ROS_DOMAIN_ID $RMW_IMPLEMENTATION $ZENOH_CONFIG_OVERRIDE       # expect 62, rmw_zenoh_cpp, connect/endpoints=["tcp/<pi>:7447"]
ros2 service list --no-daemon | grep screen_manager
ros2 service call /screen_manager_node/set_display_class screen_interfaces/srv/SetDisplayClass "{category: 'metal'}"
```
## TO-DO
- improve image resolution
- change from other to metal
- add more images

