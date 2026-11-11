# Gær on Kubernetes

Forks of gaer-base can run on a Kubernetes cluster instead of a server with docker compose. The forks are made by the
**Gær Fleet console** in Surdej (`/admin/gaer-fleet`, module `member-gaer-fleet`). Each one is named `gaer-0000N`,
sits in one GitHub organisation, gets its own namespace of the same name, and is reached at `gaer-0000N.<base domain>`
through a Cloudflare tunnel.

```
console ──PAT──▶ GitHub org: repo gaer-0000N (from template gaer-base), variables + secrets
        ──kubeconfig──▶ cluster: namespace gaer-0000N, deployer account, ghcr-pull
push to main ─▶ deploy.yml ─▶ target.yml (reads DEPLOY_TARGET) ─▶ build-image.yml (GHCR) ─▶ deploy-k8s.yml
browser ─▶ Cloudflare *.toergaer.app ─▶ tunnel ─▶ cloudflared (in cluster) ─▶ ingress ─▶ namespace gaer-0000N
```

## DEPLOY_TARGET

One repository variable decides what every workflow does. Only `target.yml` reads it. The other workflows call
`target.yml` and test its outputs (`k8s`, `compose`, `push_image`, `image`, `namespace`, `hostname`).

| `DEPLOY_TARGET` | deploy.yml | rollback.yml |
| --- | --- | --- |
| `compose` (or unset) | build in CI, ship over SSH, `deploy/deploy.sh release` | `deploy/deploy.sh rollback` |
| `k8s` | `build-image.yml` → GHCR, then `deploy-k8s.yml` → `deploy/k8s/deploy.sh release` | `kubectl rollout undo` |
| `none` | `build-image.yml` only | nothing |

gaer-base itself has no `DEPLOY_TARGET`, so it keeps deploying with compose as before.

## What the console writes into each fork

| Kind | Name | Value |
| --- | --- | --- |
| variable | `DEPLOY_TARGET` | `k8s` |
| variable | `GAER_INSTANCE` | `gaer-00001` |
| variable | `K8S_NAMESPACE` | `gaer-00001` |
| variable | `APP_HOSTNAME` | `gaer-00001.toergaer.app` |
| variable | `IMAGE_NAME` | `ghcr.io/<org>/gaer-00001` |
| variable | `UPSTREAM_REPO` | `surdej-v2/gaer-base` (used by `sync-upstream.yml`) |
| variable | `K8S_INGRESS_CLASS`, `K8S_STORAGE_CLASS` | from the cluster's settings in the console |
| variable | `DEPLOY_RUNNER` (optional, set by hand) | runner label for `deploy-k8s.yml`. Use it when the API server is private and a self-hosted runner runs in the cluster. |
| secret | `KUBE_CONFIG` | kubeconfig for the `deployer` account. It can change only its own namespace. |
| secret | `APP_ENV` | `KEY=value` lines for the app: the console's shared lines plus the fork's own lines. See `deploy/app.env.example`. |

`deploy/k8s/deploy.sh` adds the rest in the namespace and never writes it to the repo:

- `gaer-db`: Postgres passwords. Random, created once.
- `gaer-generated`: `SECRET_KEY`, `TOTP_KEYS` and `SECRET_BOX_KEYS`. Created once.
- `gaer-defaults`: `DOMAIN`, `ORIGIN` and `RP_ID`, taken from `APP_HOSTNAME`.
- `gaer-app-env`: the `APP_ENV` secret. It is rewritten on every deploy, and its lines win over the defaults.

NATS is not part of the Kubernetes stack, so events go straight to Postgres (see `app/events.py`).

## Files

- `app.yaml`: Postgres (StatefulSet + PVC), the app (Deployment with a `migrate` init container), the Service and the Ingress.
- `deploy.sh`: `release <image>` or `rollback`. The workflow calls it, and you can also run it by hand with the namespace's kubeconfig.
- `cluster/namespace.yaml`: what the console creates per fork (namespace, quota, limits, network policy, deployer account and token).
- `cluster/kubeconfig-for.sh`: prints the deployer kubeconfig for a namespace.
- `cluster/cloudflared.yaml`: one tunnel for the whole cluster.
- `CUSTOM-DOMAINS.md`: the customer's own domains (`smeden.dk`, `www.smeden.dk`, `app.smeden.dk`). Covers ownership by TXT, CNAME/ALIAS, the primary domain and redirects.

## A cluster from scratch

1. Install k3s (it brings traefik and the `local-path` storage class), or use any cluster that has an ingress controller.
2. In Cloudflare, create a remotely managed tunnel. Give it the public hostname `*.toergaer.app` →
   `http://traefik.kube-system.svc.cluster.local:80`, and add the DNS record `*.toergaer.app` as a proxied CNAME to
   `<tunnel-id>.cfargotunnel.com`.
3. In the console, go to **Clusters** → upload the admin kubeconfig → **Install or update cloudflared** with the tunnel token.
   By hand, the same thing is `kubectl apply -f cluster/cloudflared.yaml` plus the `tunnel-token` secret.
4. **Forks** → **Create fork**.

## By hand, without the console

```bash
NAMESPACE=gaer-00001 envsubst '${NAMESPACE}' < deploy/k8s/cluster/namespace.yaml | kubectl apply -f -
deploy/k8s/cluster/kubeconfig-for.sh gaer-00001 | gh secret set KUBE_CONFIG -R <org>/gaer-00001
gh variable set DEPLOY_TARGET -b k8s -R <org>/gaer-00001
gh variable set K8S_NAMESPACE -b gaer-00001 -R <org>/gaer-00001
gh variable set APP_HOSTNAME -b gaer-00001.toergaer.app -R <org>/gaer-00001
```

Then add a `ghcr-pull` secret in the namespace (`kubectl create secret docker-registry ghcr-pull …` with a
`read:packages` token), or set the repo secret `GHCR_PULL_TOKEN`, and run `deploy.yml`.
