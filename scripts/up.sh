#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ ! -f .env ]; then
  echo "missing .env — copy .env.example first" >&2
  exit 1
fi
set -a && . ./.env && set +a
docker compose up -d --build
echo "panel: http://${BIND_ADDR:-127.0.0.1}:${HTTP_PORT:-36090}"
if [ -z "${AUTH_PASSWORD:-}" ]; then
  echo "first visit will guide you through creating the admin account"
fi
