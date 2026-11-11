#!/usr/bin/env bash
# Rolls one Gær instance out to its namespace. Called by .github/workflows/deploy-k8s.yml; can also be run by hand
# with a kubeconfig for the namespace (the console's deployer account is enough — it may only touch its namespace).
#
#   deploy/k8s/deploy.sh release <image>    secrets, manifests, migrate (init container), wait for /health
#   deploy/k8s/deploy.sh rollback           the previous ReplicaSet of the app
#
# Environment (the workflow sets these from repository variables and secrets):
#   NAMESPACE        e.g. gaer-00001                       (vars.K8S_NAMESPACE)
#   APP_HOSTNAME     e.g. gaer-00001.toergaer.app          (vars.APP_HOSTNAME)
#   INGRESS_CLASS    default traefik                       (vars.K8S_INGRESS_CLASS)
#   STORAGE_CLASS    default local-path                    (vars.K8S_STORAGE_CLASS)
#   DB_STORAGE       default 10Gi                          (vars.K8S_DB_STORAGE)
#   APP_ENV          KEY=value lines for app.env           (secrets.APP_ENV, optional)
#   GHCR_PULL_TOKEN  read:packages token for ghcr-pull     (secrets.GHCR_PULL_TOKEN, optional — the console
#                    normally creates ghcr-pull when it makes the namespace)

set -euo pipefail
cd "$(dirname "$0")"

log() { echo "[deploy-k8s] $*"; }
: "${NAMESPACE:?NAMESPACE required}"
export NAMESPACE
export INGRESS_CLASS=${INGRESS_CLASS:-traefik}
export STORAGE_CLASS=${STORAGE_CLASS:-local-path}
export DB_STORAGE=${DB_STORAGE:-10Gi}
k() { kubectl -n "$NAMESPACE" "$@"; }
hex() { openssl rand -hex "$1"; }
key() { echo "1:$(openssl rand -base64 32)"; }

ensure_once() {  # name, then key=value pairs — created only when missing, never rotated by a deploy
  local name=$1; shift
  if k get secret "$name" >/dev/null 2>&1; then return 0; fi
  log "creating secret $name"
  local args=()
  for kv in "$@"; do args+=(--from-literal="$kv"); done
  k create secret generic "$name" "${args[@]}"
}

apply_config() {
  : "${APP_HOSTNAME:?APP_HOSTNAME required}"
  export APP_HOSTNAME
  ensure_once gaer-db \
    POSTGRES_PASSWORD="$(hex 24)" DB_OWNER_PASSWORD="$(hex 24)" DB_APP_PASSWORD="$(hex 24)" \
    DB_PURGE_PASSWORD="$(hex 24)" DB_MCP_RO_PASSWORD="$(hex 24)"
  ensure_once gaer-generated SECRET_KEY="$(hex 32)" TOTP_KEYS="$(key)" SECRET_BOX_KEYS="$(key)"

  # Defaults from the hostname; any line in APP_ENV wins (it comes later in envFrom).
  k create configmap gaer-defaults --dry-run=client -o yaml \
    --from-literal=DOMAIN="$APP_HOSTNAME" --from-literal=ORIGIN="https://$APP_HOSTNAME" \
    --from-literal=RP_ID="$APP_HOSTNAME" --from-literal=WEB_FRONT=markdown | kubectl apply -f -

  local envfile; envfile=$(mktemp); trap 'rm -f "$envfile"' RETURN
  printf '%s\n' "${APP_ENV:-}" | grep -E '^[A-Za-z_][A-Za-z0-9_]*=' > "$envfile" || true
  k create secret generic gaer-app-env --dry-run=client -o yaml --from-env-file="$envfile" | kubectl apply -f -

  k create configmap postgres-init --dry-run=client -o yaml \
    --from-file=10-gaer.sh=../postgres-init.sh | kubectl apply -f -

  if [ -n "${GHCR_PULL_TOKEN:-}" ]; then
    k create secret docker-registry ghcr-pull --dry-run=client -o yaml --docker-server=ghcr.io \
      --docker-username="${GHCR_PULL_USER:-gaer}" --docker-password="$GHCR_PULL_TOKEN" | kubectl apply -f -
  fi
}

release() {
  local image=$1 tag
  tag=${image##*:}
  export IMAGE=$image GAER_VERSION=${tag::7}
  apply_config
  log "applying manifests for $image"
  envsubst '${NAMESPACE} ${IMAGE} ${GAER_VERSION} ${APP_HOSTNAME} ${INGRESS_CLASS} ${STORAGE_CLASS} ${DB_STORAGE}' \
    < app.yaml | kubectl apply -f -
  k rollout status statefulset/postgres --timeout=180s
  if k rollout status deployment/gaer --timeout=300s; then
    log "released $image"
    return 0
  fi
  log "new version did not become ready; rolling back"
  k logs deployment/gaer -c migrate --tail=80 || true
  k logs deployment/gaer -c app --tail=80 || true
  k rollout undo deployment/gaer || true
  return 1
}

case "${1:-}" in
  release) release "${2:?image required}" ;;
  rollback) k rollout undo deployment/gaer && k rollout status deployment/gaer --timeout=300s ;;
  *) echo "usage: $0 release <image> | rollback" >&2; exit 2 ;;
esac
