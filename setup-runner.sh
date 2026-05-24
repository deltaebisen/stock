#!/bin/bash
# GitHub Actions self-hosted runner を NAS 上の Docker コンテナとして起動する。
#
# PAT (Personal Access Token) 方式:
#   ACCESS_TOKEN を渡すと myoung34/github-runner が起動時に自分で registration token を
#   発行して登録する。NAS 再起動・コンテナ再作成・GitHub 側で消えた場合も、起動するだけで
#   自動的に再登録される。短期失効する registration token を毎回手で取る必要は無い。
#
# 事前準備:
#   1. Windows 側で runner image を pull (ARM64):
#        docker pull --platform linux/arm64 myoung34/github-runner:latest
#        docker save myoung34/github-runner:latest | gzip > github-runner.tar.gz
#        scp -P 9222 github-runner.tar.gz shoootake@192.168.10.2:/mnt/public/develop/stock/
#   2. NAS 側で load:
#        gunzip -c github-runner.tar.gz | docker load
#        rm github-runner.tar.gz
#   3. GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens
#      で PAT を発行:
#        - Resource owner: 対象 repo の owner
#        - Repository access: Only select repositories → 対象 repo のみ
#        - Repository permissions: Administration = Read and write
#        - Expiration: 任意 (無期限 / 1 年など。失効したら作り直して再 setup)
#
# 使い方:
#   ./setup-runner.sh <owner>/<repo> <PAT>
#   例: ./setup-runner.sh deltaebisen/stock github_pat_xxxxxxxxxxxxxxxxxxxx

set -e

if [ $# -ne 2 ]; then
  echo "Usage: $0 <owner>/<repo> <personal_access_token>"
  echo "Example: $0 deltaebisen/stock github_pat_xxxxxxxxxxxx"
  exit 1
fi

REPO="$1"
PAT="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 既存 runner を入れ替え
docker rm -f stock-runner 2>/dev/null || true

docker run -d \
  --name stock-runner \
  --restart always \
  -e REPO_URL="https://github.com/${REPO}" \
  -e RUNNER_NAME="nas-runner" \
  -e ACCESS_TOKEN="${PAT}" \
  -e RUNNER_WORKDIR="/tmp/runner-work" \
  -e LABELS="self-hosted,nas,arm64" \
  -e EPHEMERAL="false" \
  -e NAS_WORKSPACE="${SCRIPT_DIR}" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${SCRIPT_DIR}:${SCRIPT_DIR}" \
  myoung34/github-runner:latest

# 注: -v "${SCRIPT_DIR}:${SCRIPT_DIR}" でホストと同じパスにマウントしている。
# runner は docker.sock 経由で sibling container を spawn するが、その時の volume
# パス指定はホスト Docker daemon に渡されるためホスト視点でのパスが必要。
# `${SCRIPT_DIR}:/workspace` のように違う名前にすると run.sh が SCRIPT_DIR を
# `/workspace` と認識して `docker run -v /workspace/frontend:/app` をホスト側に
# 投げ、ホストに /workspace が無いので空マウントになり package.json が見えない。
# NAS_WORKSPACE 環境変数を deploy.yml に渡してホスト絶対パスを参照させる。

echo ""
echo "Runner 起動済み。確認:"
echo "  docker logs -f stock-runner"
echo ""
echo "GitHub repo > Settings > Actions > Runners で 'nas-runner' が Idle になれば成功"
echo "(以降は NAS 再起動やコンテナ再作成でも自動再登録される)"
