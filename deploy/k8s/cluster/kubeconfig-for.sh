#!/usr/bin/env bash
# Prints a kubeconfig for the deployer account in one namespace (see namespace.yaml), for the repo secret
# KUBE_CONFIG. Run with an admin kubeconfig for the cluster.
#
#   deploy/k8s/cluster/kubeconfig-for.sh gaer-00001 > kubeconfig-gaer-00001.yaml
set -euo pipefail
ns=${1:?namespace required}
server=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
ca=$(kubectl -n "$ns" get secret deployer-token -o jsonpath='{.data.ca\.crt}')
token=$(kubectl -n "$ns" get secret deployer-token -o jsonpath='{.data.token}' | base64 -d)
cat <<YAML
apiVersion: v1
kind: Config
clusters:
  - name: gaer
    cluster: { server: "$server", certificate-authority-data: "$ca" }
users:
  - name: deployer
    user: { token: "$token" }
contexts:
  - name: $ns
    context: { cluster: gaer, user: deployer, namespace: $ns }
current-context: $ns
YAML
