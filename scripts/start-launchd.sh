#!/bin/bash
set -euo pipefail

if [[ -f "${PWD}/package.json" && -d "${PWD}/prisma" ]]; then
  PROJECT_DIR="${PWD}"
else
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi

cd "${PROJECT_DIR}"

export HOME="${HOME:-/Users/iamin}"
export LANG="${LANG:-en_US.UTF-8}"
NODE_PATH_PREFIX=""
if [[ -d "${HOME}/.nvm/versions/node" ]]; then
  LATEST_NODE="$(ls "${HOME}/.nvm/versions/node" | sort -V | tail -n 1)"
  if [[ -n "${LATEST_NODE}" ]]; then
    NODE_PATH_PREFIX="${HOME}/.nvm/versions/node/${LATEST_NODE}/bin:"
  fi
fi
export PATH="${NODE_PATH_PREFIX}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if [[ -s "${HOME}/.nvm/nvm.sh" ]]; then
  # Load nvm for launchd sessions, which do not inherit shell init files.
  . "${HOME}/.nvm/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || nvm use --silent >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[launchd] node is not available on PATH" >&2
  exit 127
fi

PORT="${PORT:-3003}"
export PORT
export DATABASE_URL="${DATABASE_URL:-file:${PROJECT_DIR}/prisma/dev.db}"
export SIFTLY_INTERNAL_BASE_URL="${SIFTLY_INTERNAL_BASE_URL:-http://127.0.0.1:${PORT}}"

if [[ ! -d node_modules ]]; then
  npm install
fi

if [[ ! -f app/generated/prisma/client.ts || prisma/schema.prisma -nt app/generated/prisma/client.ts ]]; then
  npx prisma generate
fi

if [[ ! -f prisma/dev.db ]]; then
  npx prisma migrate deploy 2>/dev/null || npx prisma db push
else
  npx prisma migrate deploy 2>/dev/null || true
fi

exec ./node_modules/.bin/next dev --hostname 127.0.0.1 --port "${PORT}"
