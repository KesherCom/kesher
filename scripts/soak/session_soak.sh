#!/usr/bin/env bash
set -u

BASE_URL="${1:-http://localhost:8080}"
USERS="${2:-20}"
ROUNDS="${3:-10}"

echo "Running session soak against ${BASE_URL} with ${USERS} users for ${ROUNDS} rounds"

for round in $(seq 1 "${ROUNDS}"); do
  echo "round ${round}/${ROUNDS}"
  for idx in $(seq 1 "${USERS}"); do
    username="soak-user-${round}-${idx}"
    token="$(curl -sS -X POST "${BASE_URL}/api/login" \
      -H "Content-Type: application/json" \
      -d "{\"username\":\"${username}\",\"roleId\":\"audio\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
    if [[ -z "${token}" ]]; then
      echo "failed to get token for ${username}"
      exit 1
    fi
    curl -sS -H "Authorization: Bearer ${token}" "${BASE_URL}/api/bootstrap" >/dev/null || exit 1
    curl -sS -X POST -H "Authorization: Bearer ${token}" "${BASE_URL}/api/logout" >/dev/null || exit 1
  done
done

echo "session soak completed successfully"

