# Gær Terminalsupport on AKS

| Branch | Namespace | URL | Image (ACR) | Database |
| --- | --- | --- | --- | --- |
| `main` | `gaer-terminalsupport` | https://gaer-terminalsupport.cluster1.nexi-ms-ops-nordics.net | `msops.azurecr.io/gaer-terminalsupport:latest` | `gaer_terminalsupport` |
| `canary` | `gaer-terminalsupport-canary` | https://gaer-terminalsupport-canary.cluster1.nexi-ms-ops-nordics.net | `msops.azurecr.io/gaer-terminalsupport-canary:latest` | `gaer_terminalsupport_canary` |

- **Cluster** `msops1` (resource group `kubernetes`), Caddy ingress + cert-manager (`letsencrypt-prod`).
- **Postgres** `nexivibe.postgres.database.azure.com` (Azure Flexible Server, `Prototype-001`); databases and the four
  roles per database were made with `deploy/provision_database.py`. Only reachable from Azure (firewall), so run
  that script from a pod in the cluster.
- **Storage** account `stgaerterminalsupport` (`kubernetes`, swedencentral), one blob container per namespace,
  `STORAGE_BACKEND=azure` (`server/app/storage.py` → `AzureBlobStorage`; direct upload with SAS links, CORS is
  set by the job `storage.cors`).
- **ACR** `msops` — the kubelet identity of msops1 has AcrPull.

## Deploy
Push to `main` or `canary` → `aks-main.yml` / `aks-canary.yml` → `aks-deploy.yml`: tests, `docker build`, push
`:latest` and `:<sha>`, `kubectl apply -k deploy/aks/overlays/<branch>`, `rollout restart`. No downtime:
`maxUnavailable: 0`, the new pod migrates in its init container and must pass `/health` before the old one stops.

Azure login is OIDC: managed identity `id-gaer-terminalsupport-github` (`kubernetes`) with federated credentials
for the GitHub environments `production` (branch main) and `canary` (branch canary); roles AcrPush on `msops` and
AKS Cluster User on `msops1`. Repo variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

Rollback to a commit: `kubectl -n <ns> set image deployment/gaer app=<image>:<sha> migrate=<image>:<sha>`.

## Settings — the secret `gaer-env`
All app settings (see `deploy/app.env.example`) live in the secret `gaer-env` in each namespace, never in the repo.
`GAER_ENV`, `TRUST_PROXY` and `STORAGE_BACKEND` are set in the deployment. To change one value:

```sh
kubectl -n gaer-terminalsupport get secret gaer-env -o json \
  | jq '.data.MAIL_PROVIDER="'$(printf lettermint | base64)'"' | kubectl apply -f -
kubectl -n gaer-terminalsupport rollout restart deployment/gaer
```

`DEMO_MODE=1` is on until a mail provider is set: login codes are written to the pod log
(`kubectl -n <ns> logs deploy/gaer -c app | grep "DEMO_MODE mail"`). Set `MAIL_PROVIDER`, `MAIL_FROM`, its token and remove
`DEMO_MODE` to send real mail.
