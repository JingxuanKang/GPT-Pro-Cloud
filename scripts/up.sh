#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [ ! -f .env ]; then
  echo "missing .env — copy .env.example first" >&2
  exit 1
fi
set -a && . ./.env && set +a
if ! docker compose pull; then
  echo "Could not pull public GHCR images." >&2
  echo "Next step: build locally with  docker compose up -d --build" >&2
  echo "Or wait for the publish workflow on main to push:" >&2
  echo "  ghcr.io/jingxuankang/gpt-pro-cloud-gateway:latest" >&2
  echo "  ghcr.io/jingxuankang/gpt-pro-cloud-desktop:latest" >&2
  exit 1
fi
docker compose up -d
echo "panel: http://${BIND_ADDR:-127.0.0.1}:${HTTP_PORT:-36090}"
if [ -z "${AUTH_PASSWORD:-}" ]; then
  echo "first visit will guide you through creating the admin account"
fi
