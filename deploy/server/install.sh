#!/usr/bin/env bash
# Kesher server installer for Linux (Debian, Ubuntu, Raspberry Pi OS, Fedora,
# ...). Installs Docker if needed, sets up /opt/kesher from deploy/server,
# opens the firewall, starts the server and installs the `kesher` command.
#
#   curl -fsSL https://raw.githubusercontent.com/KesherCom/kesher/main/deploy/server/install.sh | sudo bash
#
# Options (or the environment variables in brackets):
#   --pin PIN        admin PIN (KESHER_ADMIN_PIN); asked for if missing
#   --version X.Y.Z  image version, default latest (KESHER_VERSION)
#   --ref REF        git branch/tag to take the setup files from, default
#                    main (KESHER_REF)
#   --build          build the image from REF on this machine instead of
#                    downloading it (to test a branch before a release)
#   --dir DIR        install directory, default /opt/kesher (KESHER_DIR)
#   --yes            do not ask; install Docker if missing
#
# Running it again is safe: it keeps .env (PIN, ports) and the data, and
# updates the setup files and the image. Guide: docs/deployment/server.md
set -euo pipefail

REPO="KesherCom/kesher"
REF="${KESHER_REF:-main}"
VERSION="${KESHER_VERSION:-}"
DIR="${KESHER_DIR:-/opt/kesher}"
PIN="${KESHER_ADMIN_PIN:-}"
BUILD=0
YES=0

usage() {
  cat <<'EOF'
Kesher server installer.
  curl -fsSL https://raw.githubusercontent.com/KesherCom/kesher/main/deploy/server/install.sh | sudo bash
  ... | sudo bash -s -- [options]

  --pin PIN        admin PIN (letters, digits, . - _); asked for if missing
  --version X.Y.Z  image version (default: latest)
  --ref REF        branch or tag for the setup files (default: main)
  --build          build the image from REF here instead of downloading it
  --dir DIR        install directory (default: /opt/kesher)
  --yes            do not ask questions
EOF
}

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m ok\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m !!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --pin) PIN="${2:?--pin needs a value}"; shift 2
           [[ "$PIN" =~ ^[A-Za-z0-9._-]+$ ]] || die "the PIN may only use letters, digits, . - _" ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --yes|-y) YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done
VERSION="${VERSION#v}"
RAW="https://raw.githubusercontent.com/$REPO/$REF/deploy/server"
# Testing: KESHER_SOURCE_DIR=<repo checkout> takes deploy/server and (with
# --build) the image source from that directory instead of GitHub.
SOURCE_DIR="${KESHER_SOURCE_DIR:-}"
fetch() { # fetch FILE DEST: one file of deploy/server
  if [ -n "$SOURCE_DIR" ]; then cp "$SOURCE_DIR/deploy/server/$1" "$2"; else curl -fsSL "$RAW/$1" -o "$2"; fi
}

# Questions go to the terminal even when the script is piped into bash.
ask() {
  local prompt="$1" answer=""
  if [ "$YES" = 1 ] || [ ! -r /dev/tty ]; then return 0; fi
  read -r -p "$prompt [Y/n] " answer </dev/tty || true
  case "$answer" in [nN]*) return 1 ;; *) return 0 ;; esac
}

[ "$(uname -s)" = Linux ] || die "this installer is for Linux. On Windows/Mac see docs/deployment/server.md."
[ "$(id -u)" = 0 ] || die "please run as root: curl ... | sudo bash"
command -v curl >/dev/null || die "curl is missing (apt install curl)"

# ── 1. Docker ──────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null; then
  ask "Docker is not installed. Install it now (get.docker.com)?" || die "Docker is required."
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "the Docker Compose plugin is missing (apt install docker-compose-plugin)"
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?')"

# ── 2. Setup files ─────────────────────────────────────────────────────────
say "Setting up $DIR (files from ${SOURCE_DIR:-$REF})"
mkdir -p "$DIR"
cd "$DIR"
fetch docker-compose.yml docker-compose.yml.new || die "cannot download $RAW/docker-compose.yml (wrong --ref?)"
mv docker-compose.yml.new docker-compose.yml
fetch kesher /usr/local/bin/kesher.new || die "cannot download the kesher command"
chmod 755 /usr/local/bin/kesher.new && mv /usr/local/bin/kesher.new /usr/local/bin/kesher

set_env() { # set_env KEY VALUE: replace or append in .env
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}

if [ -f .env ]; then
  ok "keeping existing settings (.env)"
  [ -n "$PIN" ] && set_env ADMIN_PIN "$PIN"
else
  fetch .env.example .env || die "cannot download .env.example"
  if [ -z "$PIN" ] && [ -r /dev/tty ] && [ "$YES" = 0 ]; then
    while :; do
      read -r -s -p "Choose an admin PIN (for the admin area): " PIN </dev/tty; echo
      [[ "$PIN" =~ ^[A-Za-z0-9._-]+$ ]] || { warn "use letters, digits, . - _ (not empty)"; continue; }
      read -r -s -p "Repeat the PIN: " pin2 </dev/tty; echo
      [ "$PIN" = "$pin2" ] && break
      warn "the PINs do not match"
    done
  fi
  [ -n "$PIN" ] || die "no admin PIN: pass --pin PIN"
  set_env ADMIN_PIN "$PIN"
fi
grep -Eq '^ADMIN_PIN=[A-Za-z0-9._-]+$' .env || die "ADMIN_PIN in $DIR/.env must be set and use only letters, digits, . - _"

[ -n "$VERSION" ] && set_env KESHER_VERSION "$VERSION"
chmod 600 .env
# How this install gets its image; read by `kesher update`.
printf 'REF=%s\nBUILD=%s\n' "$REF" "$BUILD" > .install

env_value() { sed -n "s/^$1=//p" .env | tail -n 1; }
TAG="$(env_value KESHER_VERSION)"; TAG="${TAG:-latest}"
HTTPS_PORT="$(env_value KESHER_HTTPS_PORT)"; HTTPS_PORT="${HTTPS_PORT:-8443}"
HTTP_PORT="$(env_value KESHER_HTTP_PORT)"; HTTP_PORT="${HTTP_PORT:-8080}"
NATIVE_PORT="$(env_value KESHER_NATIVE_UDP_PORT)"; NATIVE_PORT="${NATIVE_PORT:-8081}"
WEBRTC_PORT="$(env_value KESHER_WEBRTC_UDP_PORT)"; WEBRTC_PORT="${WEBRTC_PORT:-8082}"

# ── 3. Image ───────────────────────────────────────────────────────────────
IMAGE="ghcr.io/keshercom/kesher-selfsigned:$TAG"
if [ "$BUILD" = 1 ]; then
  [ -n "$SOURCE_DIR" ] || command -v git >/dev/null || die "--build needs git (apt install git)"
  say "Building the image from ${SOURCE_DIR:-$REF} (takes a few minutes)"
  if [ -n "$SOURCE_DIR" ]; then
    rm -rf src && cp -r "$SOURCE_DIR" src
  elif [ -d src/.git ]; then
    git -C src fetch --depth 1 origin "$REF" && git -C src checkout -q FETCH_HEAD
  else
    rm -rf src && git clone -q --depth 1 -b "$REF" "https://github.com/$REPO.git" src
  fi
  docker build -q -f src/deploy/docker/Dockerfile --target selfsigned \
    --build-arg VERSION="$REF" -t "$IMAGE" src >/dev/null
else
  say "Downloading the image ($IMAGE)"
  docker compose pull -q || die "cannot download $IMAGE. Before the first release use --build --ref <branch>."
fi
ok "image ready"

# ── 4. Firewall ────────────────────────────────────────────────────────────
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$HTTPS_PORT/tcp" >/dev/null
  ufw allow "$HTTP_PORT/tcp" >/dev/null
  ufw allow "$NATIVE_PORT:$WEBRTC_PORT/udp" >/dev/null 2>&1 || { ufw allow "$NATIVE_PORT/udp" >/dev/null; ufw allow "$WEBRTC_PORT/udp" >/dev/null; }
  ufw allow 5353/udp >/dev/null
  ok "firewall (ufw): opened $HTTPS_PORT/tcp, $HTTP_PORT/tcp, $NATIVE_PORT/udp, $WEBRTC_PORT/udp, 5353/udp (discovery)"
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  for p in "$HTTPS_PORT/tcp" "$HTTP_PORT/tcp" "$NATIVE_PORT/udp" "$WEBRTC_PORT/udp" "5353/udp"; do firewall-cmd -q --permanent --add-port="$p"; done
  firewall-cmd -q --reload
  ok "firewall (firewalld): opened $HTTPS_PORT/tcp, $HTTP_PORT/tcp, $NATIVE_PORT/udp, $WEBRTC_PORT/udp, 5353/udp (discovery)"
else
  ok "no active firewall found (ufw/firewalld); if you use another one, open $HTTPS_PORT/tcp, $HTTP_PORT/tcp, $NATIVE_PORT/udp, $WEBRTC_PORT/udp and 5353/udp"
fi

# ── 5. Start ───────────────────────────────────────────────────────────────
say "Starting Kesher"
docker compose --progress quiet up -d --remove-orphans
for _ in $(seq 1 60); do
  if curl -fsk "https://127.0.0.1:$HTTPS_PORT/api/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsk "https://127.0.0.1:$HTTPS_PORT/api/healthz" >/dev/null 2>&1 || die "the server did not come up; see: kesher logs"
ok "server is running"

# LAN addresses, without Docker's and VMs' internal bridges.
ips="$(ip -o -4 addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|cni|flannel)/ {print $4}' | cut -d/ -f1 || true)"
echo
printf '\033[1mKesher is running.\033[0m Open in a browser (accept the certificate warning once):\n'
for ip in $ips; do printf '   https://%s:%s\n' "$ip" "$HTTPS_PORT"; done
cat <<EOF

Desktop app and Raspberry Pi stations find the server by themselves in this
network (desktop app address otherwise: http://<server-ip>:$HTTP_PORT).
New Pi stations appear in the admin area under "Stations" for approval.
Admin area: the PIN you chose (change it in $DIR/.env, then: kesher restart).

Manage it with the kesher command:
   kesher status | logs | update | restart | backup | help
EOF
