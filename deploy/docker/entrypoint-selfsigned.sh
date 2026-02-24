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

  openssl req -x509 -newkey rsa:2048 -sha256 -days "$CERT_DAYS" -nodes \
    -keyout "$TLS_KEY_FILE" \
    -out "$TLS_CERT_FILE" \
    -subj "/CN=$CERT_HOST" \
    -addext "subjectAltName=$SAN"
fi

export APP_ADDR="${APP_ADDR:-:$APP_HTTPS_PORT}"
export DB_PATH="${DB_PATH:-/app/data/intercom.db}"
export TRUSTED_LAN_HTTP="${TRUSTED_LAN_HTTP:-false}"
export TLS_CERT_FILE
export TLS_KEY_FILE

exec /app/server
