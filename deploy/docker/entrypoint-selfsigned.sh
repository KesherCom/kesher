#!/bin/sh
set -eu

CERT_DIR="${CERT_DIR:-/app/certs}"
TLS_CERT_FILE="${TLS_CERT_FILE:-$CERT_DIR/tls.crt}"
TLS_KEY_FILE="${TLS_KEY_FILE:-$CERT_DIR/tls.key}"
CERT_HOST="${CERT_HOST:-localhost}"
CERT_DAYS="${CERT_DAYS:-365}"
APP_HTTPS_PORT="${APP_HTTPS_PORT:-8443}"

mkdir -p "$CERT_DIR" /app/data

is_ip() {
  echo "$1" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
}

if [ ! -f "$TLS_CERT_FILE" ] || [ ! -f "$TLS_KEY_FILE" ]; then
  SAN="DNS:localhost"
  if [ "$CERT_HOST" != "localhost" ]; then
    if is_ip "$CERT_HOST"; then
      SAN="$SAN,IP:$CERT_HOST"
    else
      SAN="$SAN,DNS:$CERT_HOST"
    fi
  fi
  if [ -n "${CERT_EXTRA_SAN:-}" ]; then
    SAN="$SAN,${CERT_EXTRA_SAN}"
  fi
  # Every IPv4 address of this machine, so https://<server-ip> works with
  # no configuration. With network_mode: host (deploy/server) these are the
  # server's real LAN addresses. CERT_AUTO_SAN=false turns this off.
  if [ "${CERT_AUTO_SAN:-true}" = "true" ]; then
    for ip in $(ip -o -4 addr show 2>/dev/null | awk '{print $4}' | cut -d/ -f1); do
      case "$ip" in 127.*) continue ;; esac
      case ",$SAN," in *",IP:$ip,"*) ;; *) SAN="$SAN,IP:$ip" ;; esac
    done
    host_name="$(hostname 2>/dev/null || true)"
    if [ -n "$host_name" ]; then
      case ",$SAN," in *",DNS:$host_name,"*) ;; *) SAN="$SAN,DNS:$host_name" ;; esac
    fi
  fi

  openssl req -x509 -newkey rsa:2048 -sha256 -days "$CERT_DAYS" -nodes \
    -keyout "$TLS_KEY_FILE" \
    -out "$TLS_CERT_FILE" \
    -subj "/CN=$CERT_HOST" \
    -addext "subjectAltName=$SAN"
  echo "kesher: generated self-signed certificate for $SAN (valid $CERT_DAYS days)"
fi

export APP_ADDR="${APP_ADDR:-:$APP_HTTPS_PORT}"
export DB_PATH="${DB_PATH:-/app/data/intercom.db}"
export TRUSTED_LAN_HTTP="${TRUSTED_LAN_HTTP:-false}"
# The server defaults to TLS_MODE=internal (ephemeral cert); use our file.
export TLS_MODE=file
export TLS_CERT_FILE
export TLS_KEY_FILE

exec /app/server
