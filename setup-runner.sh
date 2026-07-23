#!/bin/bash
# GitHub Actions self-hosted runner を NAS 上の Docker コンテナとして起動する。
#
# PAT (Personal Access Token) 方式:
#   ACCESS_TOKEN を渡すと myoung34/github-runner が起動時に自分で registration token を
#   発行して登録する。NAS 再起動・コンテナ再作成・GitHub 側で消えた場合も、起動するだけで
#   自動的に再登録される。短期失効する registration token を毎回手で取る必要は無い。
#
# PAT は .env から読む:
#   bash history や docker inspect への漏出を避けるため、PAT は CLI 引数ではなく
#   .env の RUNNER_PAT エントリから読む (.env は gitignore 済 & CI rsync 除外で
#   NAS local 保持。DB_PASSWORD 等と同じ流儀)。
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
#   4. NAS の .env に追記:
#        RUNNER_PAT=github_pat_xxxxxxxxxxxxxxxxxxxx
#
# 使い方:
#   ./setup-runner.sh <owner>/<repo>
#   例: ./setup-runner.sh deltaebisen/stock

set -e

if [ $# -ne 1 ]; then
  echo "Usage: $0 <owner>/<repo>"
  echo "Example: $0 deltaebisen/stock"
  echo ""
  echo "PAT は .env の RUNNER_PAT から読む。.env.example を参照。"
  exit 1
fi

REPO="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -f "$SCRIPT_DIR/.env" ]; then
  echo "Error: $SCRIPT_DIR/.env が見つかりません。.env.example をコピーして RUNNER_PAT を埋めてください。"
  exit 1
fi

# .env を読み込む (export 付きで)
set -a
# shellcheck disable=SC1091
source "$SCRIPT_DIR/.env"
set +a

if [ -z "${RUNNER_PAT:-}" ]; then
  echo "Error: .env に RUNNER_PAT が設定されていません。"
  echo "GitHub > Settings > Developer settings > Fine-grained tokens で発行して .env に追記してください。"
  exit 1
fi

# 既存 runner を入れ替え。
# 設定 volume も一緒に消して「完全に登録し直す」状態にする (下の注 3 参照)。
# このスクリプトを叩く = クリーン再登録したい場面なので、設定の引き継ぎはしない。
docker rm -f stock-runner 2>/dev/null || true
docker volume rm stock-runner-config 2>/dev/null || true

docker run -d \
  --name stock-runner \
  --restart always \
  -e REPO_URL="https://github.com/${REPO}" \
  -e RUNNER_NAME="nas-runner" \
  -e ACCESS_TOKEN="${RUNNER_PAT}" \
  -e RUNNER_WORKDIR="/tmp/runner-work" \
  -e LABELS="self-hosted,nas,arm64" \
  -e NAS_WORKSPACE="${SCRIPT_DIR}" \
  -e CONFIGURED_ACTIONS_RUNNER_FILES_DIR="/runner-files" \
  -e DISABLE_AUTOMATIC_DEREGISTRATION="true" \
  -v stock-runner-config:/runner-files \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "${SCRIPT_DIR}:${SCRIPT_DIR}" \
  myoung34/github-runner:latest

# 注 1: -v "${SCRIPT_DIR}:${SCRIPT_DIR}" でホストと同じパスにマウントしている。
# runner は docker.sock 経由で sibling container を spawn するが、その時の volume
# パス指定はホスト Docker daemon に渡されるためホスト視点でのパスが必要。
#
# 注 2: EPHEMERAL は **絶対に渡さない** (unset = persistent)。
# myoung34/github-runner の start.sh は `[[ -n "${EPHEMERAL}" ]]` で判定するので、
# `EPHEMERAL=false` を渡しても "非空文字列" として ephemeral mode に倒れる。
# ephemeral runner はジョブ 1 つ取ったら deregister → exit するので、--restart always
# で再起動するたび GitHub 側 Runners 一覧から一瞬消えるフリッカー状態になる。
# `${SCRIPT_DIR}:/workspace` のように違う名前にすると run.sh が SCRIPT_DIR を
# `/workspace` と認識して `docker run -v /workspace/frontend:/app` をホスト側に
# 投げ、ホストに /workspace が無いので空マウントになり package.json が見えない。
# NAS_WORKSPACE 環境変数を deploy.yml に渡してホスト絶対パスを参照させる。
#
# 注 3: CONFIGURED_ACTIONS_RUNNER_FILES_DIR (= runner reusage) は
# **--restart always と組で必須**。これが無いと再起動のたびに死ぬ。
#
# myoung34/github-runner の entrypoint.sh は起動のたびに config.sh で登録処理を
# 走らせる (= コンテナは使い捨て前提)。reusage 無効だと再起動時も再登録を試み、
# ここで config.sh が
#   Cannot configure the runner because it is already configured.
#   An error occurred: Value cannot be null. (Parameter 'configuredSettings')
# を出して即 exit → --restart always が再起動 → 同じエラー、の無限ループに入る。
# 一度でも再起動したら二度と復帰せず、GitHub 側では runner が offline のまま
# scheduled workflow が queued で溜まり続け、24h でタイムアウト cancel される。
# (2026-07 に実際に発生。notify の OOM でコンテナが巻き込み再起動したのが発端で、
#  4 日ぶん daily batch が全部 cancelled になった)
#
# reusage を有効にすると entrypoint は設定を /runner-files (named volume) に
# 退避し、次回起動時はコピーして戻したうえで
#   if [ -f "/actions-runner/.runner" ]; then echo "The runner has already been configured"
# と **config.sh を丸ごとスキップ**して listener だけ起動する。これで再起動に耐える。
#
# DISABLE_AUTOMATIC_DEREGISTRATION=true は reusage と同時に必須。false のままだと
# entrypoint が「deregister 済み runner を再利用すると壊れる」として exit 1 する。
# 停止時に GitHub から deregister しなくなるので runner 一覧には残り続けるが、
# persistent runner ではむしろそれが正しい。

echo ""
echo "Runner 起動済み。確認:"
echo "  docker logs -f stock-runner"
echo ""
echo "GitHub repo > Settings > Actions > Runners で 'nas-runner' が Idle になれば成功"
echo "(以降は NAS 再起動やコンテナ再作成でも自動再登録される)"
