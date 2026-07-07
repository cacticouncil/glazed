#! /usr/bin/env bash
set -euo pipefail

if [ ! -f .env ]; then
  cp .env.example .env
fi

podman compose down -v || true
podman compose up -d --build

echo "Glazed is running:"
echo "  Admin app: http://localhost"
echo "  Backend docs: http://localhost:8000/docs"
