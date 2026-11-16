#!/usr/bin/env bash
# One-time setup when the devcontainer is created (postCreateCommand).
set -e
cd "$(dirname "$0")/.."

[ -f .env ] || cp .env.example .env
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install --quiet -r server/requirements.txt
[ -d web/node_modules ] || npm ci --prefix web
