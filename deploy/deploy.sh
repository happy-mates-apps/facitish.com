#!/usr/bin/env bash
# Runs on the OVHcloud Public Cloud instance, in ~/gaer next to .env and Caddyfile.
# Called by .github/workflows/deploy.yml over SSH.
#
#   ./deploy.sh migrate  <image>   migrate the container's own database
#   ./deploy.sh release  <image>   start the new version next to the old one, switch when healthy
#   ./deploy.sh rollback           start the previous image again
#
# The running version is only stopped after the new one has answered /health.
# If it does not answer within 60 seconds, the new container is removed and the old one keeps running.

set -euo pipefail
cd "$(dirname "$0")"

NET=gaer
APP=gaer
NEXT=gaer-next
PROXY=gaer-caddy

log() { echo "[deploy] $*"; }

ensure_network() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
}

ensure_proxy() {
  if docker ps --format '{{.Names}}' | grep -qx "$PROXY"; then
    docker exec "$PROXY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    return
  fi
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  log "starting Caddy (TLS via Let's Encrypt)"
  docker run -d --name "$PROXY" --restart unless-stopped --network "$NET" \
    -p 80:80 -p 443:443 -p 443:443/udp \
    -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" -v caddy_data:/data -v caddy_config:/config \
    --env-file .env caddy:2 >/dev/null
}

healthy() {
  docker exec "$1" python -c \
    "import urllib.request; urllib.request.urlopen('http://localhost:8000/health', timeout=4)" >/dev/null 2>&1
}

release() {
  local image=$1
  ensure_network
  docker pull "$image"
  docker rm -f "$NEXT" >/dev/null 2>&1 || true

  log "starting $image"
  docker run -d --name "$NEXT" --network "$NET" --restart unless-stopped --env-file .env \
    -e GAER_VERSION="${image##*:}" -e TRUST_PROXY=1 "$image" >/dev/null

  for _ in $(seq 1 12); do
    if healthy "$NEXT"; then
      # Put the new container behind the proxy, then retire the old one.
      docker network disconnect "$NET" "$NEXT"
      docker network connect --alias app "$NET" "$NEXT"
      if docker ps -a --format '{{.Names}}' | grep -qx "$APP"; then
        docker inspect --format '{{.Config.Image}}' "$APP" > .previous_image
        docker rm -f "$APP" >/dev/null
      fi
      docker rename "$NEXT" "$APP"
      echo "$image" > .current_image
      ensure_proxy
      log "released $image"
      return 0
    fi
    sleep 5
  done

  log "new version did not answer /health within 60 seconds — keeping the running version"
  docker logs --tail 80 "$NEXT" || true
  docker rm -f "$NEXT" >/dev/null
  return 1
}

case "${1:-}" in
  migrate)
    image=${2:?image required}
    ensure_network
    docker pull "$image"
    log "migrating"
    docker run --rm --network "$NET" --env-file .env "$image" python -m app.migrate
    ;;
  release)
    release "${2:?image required}"
    ;;
  rollback)
    [ -f .previous_image ] || { log "no previous image recorded"; exit 1; }
    release "$(cat .previous_image)"
    ;;
  *)
    echo "usage: $0 migrate|release <image> | rollback" >&2
    exit 2
    ;;
esac
