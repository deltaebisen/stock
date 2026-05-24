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
      node:22-alpine \
      npx create-next-app@latest . --typescript --app --use-npm --eslint --no-tailwind --no-src-dir --no-import-alias --turbopack
    ;;

  web)
    # dev サーバー起動。NAS の MariaDB に 127.0.0.1:3306 で繋ぐため --network host
    if [ ! -f "$SCRIPT_DIR/frontend/package.json" ]; then
      echo "Error: ./frontend/package.json not found. Run '$0 web-init' first."
      exit 1
    fi
    docker run --rm -it \
      --name stock-web \
      --network host \
      --env-file .env \
      -v "$SCRIPT_DIR/frontend:/app" \
      -v stock-web-node-modules:/app/node_modules \
      -v stock-web-next-cache:/app/.next \
      -w /app \
      node:22-alpine \
      sh -c "npm install && npm run dev -- -H 0.0.0.0"
    ;;

  *)
    echo "Usage: $0 {build|listed|prices|prices-bg|prices-diff|prices-one|shell|web-init|web}"
    echo ""
    echo "  build              Build backend image (Python worker)"
    echo "  listed             Fetch listed companies master"
    echo "  prices             Fetch daily prices (full, default 5 years / Light plan, foreground)"
    echo "  prices-bg          Fetch daily prices (full, detached / SSH切断耐性)"
    echo "  prices-diff        Fetch daily prices (only new dates)"
    echo "  prices-one DATE    Fetch daily prices for one date (YYYY-MM-DD)"
    echo "  shell              Open shell inside backend (debug)"
    echo "  web-init           Bootstrap Next.js scaffold into ./frontend (run once)"
    echo "  web                Run Next.js dev server (http://<nas-ip>:3000)"
    exit 1
    ;;
esac
