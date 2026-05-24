#!/bin/bash
# GitHub Actions self-hosted runner を NAS 上の Docker コンテナとして起動する。
#
# 事前準備:
#   1. Windows 側で runner image を pull (ARM64):
#        docker pull --platform linux/arm64 myoung34/github-runner:latest
#        docker save myoung34/github-runner:latest | gzip > github-runner.tar.gz
#        scp -P 9222 github-runner.tar.gz shoootake@192.168.10.2:/mnt/public/develop/stock/
#   2. NAS 側で load:
#        gunzip -c github-runner.tar.gz | docker load
#        rm github-runner.tar.gz
#   3. GitHub repo > Settings > Actions > Runners > "New self-hosted runner"
#      で表示される登録 token をコピー (1時間で失効)
#
# 使い方:
#   ./setup-runner.sh <owner>/<repo> <runner_token>
#   例: ./setup-runner.sh shoootake/stock ABCDEF1234567890...

set -e

if [ $# -ne 2 ]; then
  echo "Usage: $0 <owner>/<repo> <runner_token>"
  echo "Example: $0 shoootake/stock ABCDEF1234..."
  exit 1
fi

REPO="$1"
TOKEN="$2"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 既存 runner を入れ替え
docker rm -f stock-runner 2>/dev/null || true

docker run -d \
  --name stock-runner \
  --restart always \
  -e REPO_URL="https://github.com/${REPO}" \
  -e RUNNER_NAME="nas-runner" \
  -e RUNNER_TOKEN="${TOKEN}" \
  -e RUNNER_WORKDIR="/tmp/runner-work" \
  -e LABELS="self-hosted,nas,arm64" \
  -e EPHEMERAL="false" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${SCRIPT_DIR}:/workspace" \
  myoung34/github-runner:latest

echo ""
echo "Runner 起動済み。確認:"
echo "  docker logs -f stock-runner"
echo ""
echo "GitHub repo > Settings > Actions > Runners で 'nas-runner' が Idle になれば成功"
