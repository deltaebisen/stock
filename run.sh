#!/bin/bash
# docker run でコンテナを動かすラッパースクリプト
# 使い方:
#   ./run.sh build              # backend イメージビルド
#   ./run.sh listed             # 銘柄マスタ取得
#   ./run.sh prices             # 日足取得 (フル)
#   ./run.sh prices-diff        # 日足取得 (差分)
#   ./run.sh shell              # backend コンテナ内シェルに入る (デバッグ用)
#   ./run.sh web                # Next.js dev サーバー起動

set -e

IMAGE_NAME="stock-worker"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

case "${1:-}" in
  build)
    docker build -t "$IMAGE_NAME" backend/
    ;;

  listed)
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "$IMAGE_NAME" python -m src.fetch_listed
    ;;

  calendar)
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "$IMAGE_NAME" python -m src.fetch_calendar
    ;;

  calendar-diff)
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -e FETCH_MODE=diff \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "$IMAGE_NAME" python -m src.fetch_calendar
    ;;

  prices)
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "$IMAGE_NAME" python -m src.fetch_prices
    ;;

  prices-diff)
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -e FETCH_MODE=diff \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "$IMAGE_NAME" python -m src.fetch_prices
    ;;

  prices-bg)
    # デタッチで起動 (SSH切断後も継続)。ログは docker logs -f stock-prices で追える
    docker rm -f stock-prices 2>/dev/null || true
    docker run -d \
      --name stock-prices \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "$IMAGE_NAME" python -m src.fetch_prices
    echo ""
    echo "起動済み。ログ追跡: docker logs -f stock-prices"
    echo "状態確認:     docker ps -a --filter name=stock-prices"
    echo "停止:         docker stop stock-prices"
    ;;

  prices-one)
    if [ -z "${2:-}" ]; then
      echo "Usage: $0 prices-one YYYY-MM-DD"
      exit 1
    fi
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -e FETCH_FROM="$2" \
      -e FETCH_TO="$2" \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "$IMAGE_NAME" python -m src.fetch_prices
    ;;

  backtest)
    # バックテスト実行。"backtest" 以降の全引数を python -m src.backtest に passthrough。
    # 例:
    #   ./run.sh backtest --strategy sma_cross --params fast=25,slow=75 \
    #     --universe single:1301 --from 2021-01-01 --to 2025-12-31
    #   ./run.sh backtest --strategy macd_cross --universe 'scale:TOPIX Large 70' \
    #     --from 2020-01-01 --to 2025-12-31 --name "macd large 5y"
    shift  # "backtest" を捨てて残りを passthrough
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "$IMAGE_NAME" python -m src.backtest "$@"
    ;;

  shell)
    docker run --rm -it \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "$IMAGE_NAME" bash
    ;;

  web-init)
    # Next.js プロジェクトの雛形を ./frontend に作る (初回のみ)
    if [ -d "$SCRIPT_DIR/frontend" ] && [ "$(ls -A "$SCRIPT_DIR/frontend" 2>/dev/null)" ]; then
      echo "Error: ./frontend is not empty. Remove it first if you want to re-init."
      exit 1
    fi
    mkdir -p "$SCRIPT_DIR/frontend"
    docker run --rm -it \
      -v "$SCRIPT_DIR/frontend:/app" \
      -w /app \
      node:22-bookworm-slim \
      npx create-next-app@latest . --typescript --app --use-npm --eslint --no-tailwind --no-src-dir --no-import-alias --turbopack
    ;;

  web)
    # production build → start を detached で常駐 (--restart unless-stopped)。
    # NAS の MariaDB に 127.0.0.1:3306 で繋ぐため --network host。
    # 既に起動中なら no-op (rebuild したい場合は web-rebuild を呼ぶ)。
    # next dev は TTY 無し環境で stdin EOF をトリガに exit する挙動があり
    # restart loop に陥るため、NAS では next start (production) を採用する。
    # --webpack: Next.js 16 default の Turbopack は alpine musl-arm64 で
    # native binary (SWC + Turbo Engine) が Bus error 起こすので Webpack に倒す。
    if [ ! -f "$SCRIPT_DIR/frontend/package.json" ]; then
      echo "Error: ./frontend/package.json not found. Run '$0 web-init' first."
      exit 1
    fi
    if [ -n "$(docker ps -q -f name=^stock-web$)" ]; then
      echo "stock-web は既に起動中。再 build したい場合は $0 web-rebuild"
      exit 0
    fi
    docker rm -f stock-web 2>/dev/null || true
    docker run -d \
      --name stock-web \
      --restart unless-stopped \
      --network host \
      --env-file .env \
      -v "$SCRIPT_DIR/frontend:/app" \
      -v stock-web-node-modules:/app/node_modules \
      -v stock-web-next-cache:/app/.next \
      -w /app \
      node:22-bookworm-slim \
      sh -c "npm install && npm run build -- --webpack && npm run start -- -H 0.0.0.0"
    echo ""
    echo "起動中 (http://<nas-ip>:3000)。初回は npm install + build 待ちで 2〜5 分。"
    echo "  ログ:        docker logs -f stock-web"
    echo "  状態:        docker ps -a --filter name=stock-web"
    echo "  再 build:    $0 web-rebuild"
    echo "  停止:        $0 web-stop"
    ;;

  web-rebuild)
    # 強制再起動 (新コード反映)。CI deploy はこっちを叩く。
    # .next/ は named volume なので Webpack の incremental cache が効いて
    # 2 回目以降の build はそこそこ速い (--webpack 採用理由は web case コメント参照)。
    if [ ! -f "$SCRIPT_DIR/frontend/package.json" ]; then
      echo "Error: ./frontend/package.json not found."
      exit 1
    fi
    docker rm -f stock-web 2>/dev/null || true
    docker run -d \
      --name stock-web \
      --restart unless-stopped \
      --network host \
      --env-file .env \
      -v "$SCRIPT_DIR/frontend:/app" \
      -v stock-web-node-modules:/app/node_modules \
      -v stock-web-next-cache:/app/.next \
      -w /app \
      node:22-bookworm-slim \
      sh -c "npm install && npm run build -- --webpack && npm run start -- -H 0.0.0.0"
    echo "再 build 起動中。ログ: docker logs -f stock-web"
    ;;

  web-logs)
    docker logs -f stock-web
    ;;

  web-stop)
    docker rm -f stock-web
    ;;

  *)
    echo "Usage: $0 {build|listed|calendar|calendar-diff|prices|prices-bg|prices-diff|prices-one|backtest|shell|web-init|web|web-rebuild|web-logs|web-stop}"
    echo ""
    echo "  build              Build backend image (Python worker)"
    echo "  listed             Fetch listed companies master"
    echo "  calendar           Fetch trading calendar (full, default 5 years + 翌年末まで)"
    echo "  calendar-diff      Fetch trading calendar (only new dates)"
    echo "  prices             Fetch daily prices (full, default 5 years / Light plan, foreground)"
    echo "  prices-bg          Fetch daily prices (full, detached / SSH切断耐性)"
    echo "  prices-diff        Fetch daily prices (only new dates)"
    echo "  prices-one DATE    Fetch daily prices for one date (YYYY-MM-DD)"
    echo "  backtest --strategy SMA_CROSS|RSI_MEAN_REVERSION|MACD_CROSS --universe ... --from ... --to ..."
    echo "                     Run a backtest and persist results to backtest_runs/_trades/_equity"
    echo "  shell              Open shell inside backend (debug)"
    echo "  web-init           Bootstrap Next.js scaffold into ./frontend (run once)"
    echo "  web                Build + start Next.js (production, detached, idempotent)"
    echo "  web-rebuild        Force rebuild + restart (used by CI deploy)"
    echo "  web-logs           Tail Next.js logs"
    echo "  web-stop           Stop and remove Next.js server"
    exit 1
    ;;
esac
