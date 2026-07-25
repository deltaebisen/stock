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

# python worker のメモリ上限。
#
# 上限を付けないと、メモリを食い潰したときにホストの OOM killer が「一番 RSS が
# 大きいプロセス」を選んで殺すので、無関係なコンテナが巻き添えになる。実際に
# 2026-07-19 の notify OOM で stock-runner が巻き込み再起動し、そこから runner が
# 再登録ループに入って daily batch が 4 日ぶん止まった (setup-runner.sh 注 3 参照)。
#
# --memory を付けると cgroup が「その worker だけ」を殺すので、被害がジョブ 1 本に
# 閉じる。GHA 側はステップが exit 137 で失敗するだけで、runner も MariaDB も無事。
#
# **上限は NAS の総 RAM (960MiB) より小さくないと意味が無い**。当初 1g にしていたが
# それは総 RAM より大きく、cgroup には一生到達しないまま先にホストが枯れる (=
# OOM killer が動く元の世界のまま) だった。実際 2026-07-24/25 の EDINET daily は
# これで 2 日連続 exit 137。arelle は doc 1 件 parse するのに 250MB 前後まで伸びる
# 実測なので、512m なら通常は収まり、外れ値は下の swap 側に逃げる。
#
# --memory-swap は「メモリ + swap の合計上限」。--memory だけ指定すると既定で
# メモリの 2 倍になる。NAS には swap が 1.9GB あるので明示的に広めに取り、ピークを
# swap に逃がして「遅くなるが死なない」に倒している (バッチなので遅延は許容)。
#
# NAS の空きメモリに応じて環境変数で調整可 (`WORKER_MEMORY=700m ./run.sh notify`)。
# WORKER_MEMORY=0 / 空で無効化 (= 上限なし。ホスト全体を巻き込むので非推奨)。
# カーネルが memory cgroup 非対応なら docker が警告を出して無視する。
WORKER_MEMORY="${WORKER_MEMORY:-512m}"
WORKER_MEMORY_SWAP="${WORKER_MEMORY_SWAP:-1500m}"
MEM_ARGS=()
if [ -n "$WORKER_MEMORY" ] && [ "$WORKER_MEMORY" != "0" ]; then
  MEM_ARGS=(--memory "$WORKER_MEMORY")
  if [ -n "$WORKER_MEMORY_SWAP" ] && [ "$WORKER_MEMORY_SWAP" != "0" ]; then
    MEM_ARGS+=(--memory-swap "$WORKER_MEMORY_SWAP")
  fi
fi

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
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.fetch_listed
    ;;

  calendar)
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "${MEM_ARGS[@]}" \
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
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.fetch_calendar
    ;;

  edinet-codes)
    # EDINET 公式の事業者コード一覧 (証券コード <-> EDINET コード)
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.fetch_edinet_codes
    ;;

  edinet-docs)
    # EDINET 提出書類メタの bulk 取得 (デフォルト 5 年) - 前景
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.fetch_edinet_documents
    ;;

  edinet-docs-bg)
    # bulk 取得 (デタッチ / SSH 切断耐性)
    docker rm -f stock-edinet-docs 2>/dev/null || true
    docker run -d \
      --name stock-edinet-docs \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.fetch_edinet_documents
    echo ""
    echo "起動済み。ログ追跡: docker logs -f stock-edinet-docs"
    echo "状態確認:     docker ps -a --filter name=stock-edinet-docs"
    echo "停止:         docker stop stock-edinet-docs"
    ;;

  edinet-docs-diff)
    # 差分のみ (DB の最新 submit_datetime 以降を今日まで再取得)
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -e FETCH_MODE=diff \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.fetch_edinet_documents
    ;;

  xbrl)
    # EDINET XBRL を arelle で DL → parse → financial_facts に展開 (前景)
    # parsed_at IS NULL のレコードを自然に拾うので「差分」コマンドは不要
    # 環境変数 LIMIT (1 ジョブの doc 上限) / DOC_TYPES (対象 doc_type_code カンマ区切り) を
    # 受け取って docker に passthrough する (e.g. LIMIT=1 ./run.sh xbrl で smoke test)
    # arelle web cache は名前付き volume stock-arelle-cache に永続化 (EDINET タクソノミ ~10MB の
    # 再 DL を避ける)。コンテナ再作成しても cache 維持
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -e LIMIT="${LIMIT:-}" \
      -e DOC_TYPES="${DOC_TYPES:-}" \
      -e ARELLE_CACHE_DIR=/app/data/arelle-cache \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      -v stock-arelle-cache:/app/data/arelle-cache \
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.parse_xbrl
    ;;

  xbrl-bg)
    # 同上をデタッチ (5 年フル parse は arelle で doc 1 件 ~5-10 秒 × 数万件 = 数時間〜半日)
    docker rm -f stock-xbrl 2>/dev/null || true
    docker run -d \
      --name stock-xbrl \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -e LIMIT="${LIMIT:-}" \
      -e DOC_TYPES="${DOC_TYPES:-}" \
      -e ARELLE_CACHE_DIR=/app/data/arelle-cache \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      -v stock-arelle-cache:/app/data/arelle-cache \
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.parse_xbrl
    echo ""
    echo "起動済み。ログ追跡: docker logs -f stock-xbrl"
    echo "状態確認:     docker ps -a --filter name=stock-xbrl"
    echo "停止:         docker stop stock-xbrl"
    ;;

  prices)
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "${MEM_ARGS[@]}" \
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
      "${MEM_ARGS[@]}" \
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
      "${MEM_ARGS[@]}" \
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
      "${MEM_ARGS[@]}" \
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
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.backtest "$@"
    ;;

  notify)
    # シグナル検知 + Discord 通知。"notify" 以降の引数を src.notify に passthrough。
    # 例:
    #   ./run.sh notify
    #     # default: 設定ファイル backend/config/notify.json (osgf_buy,osgf_sell + 200MA)
    #   ./run.sh notify --conditions volume_spike --params 'volume_spike:mult=5'
    #   ./run.sh notify --date 2026-05-29 --dry-run
    # 検知条件・パラメータ・スクリーニング閾値は backend/config/notify.json で調整する
    # (/app/config にマウント)。DISCORD_WEBHOOK_URL は .env から読む。
    shift
    docker run --rm \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/backend/config:/app/config" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "${MEM_ARGS[@]}" \
      "$IMAGE_NAME" python -m src.notify "$@"
    ;;

  shell)
    docker run --rm -it \
      --network host \
      --env-file .env \
      -e PYTHONUNBUFFERED=1 \
      -v "$SCRIPT_DIR/backend/src:/app/src" \
      -v "$SCRIPT_DIR/data:/app/data" \
      "${MEM_ARGS[@]}" \
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
    echo "Usage: $0 {build|listed|calendar|calendar-diff|edinet-codes|edinet-docs|edinet-docs-bg|edinet-docs-diff|xbrl|xbrl-bg|prices|prices-bg|prices-diff|prices-one|backtest|notify|shell|web-init|web|web-rebuild|web-logs|web-stop}"
    echo ""
    echo "  build              Build backend image (Python worker)"
    echo "  listed             Fetch listed companies master"
    echo "  calendar           Fetch trading calendar (full, default 5 years + 翌年末まで)"
    echo "  calendar-diff      Fetch trading calendar (only new dates)"
    echo "  edinet-codes       Fetch EDINET 事業者コード一覧 (週次想定)"
    echo "  edinet-docs        Fetch EDINET 提出書類メタ (full, default 5 years)"
    echo "  edinet-docs-bg     Same but detached"
    echo "  edinet-docs-diff   Fetch EDINET 提出書類メタ (DB 最新以降のみ)"
    echo "  xbrl               Parse EDINET XBRL → financial_facts (parsed_at NULL 全件、foreground)"
    echo "  xbrl-bg            Same but detached"
    echo "  prices             Fetch daily prices (full, default 5 years / Light plan, foreground)"
    echo "  prices-bg          Fetch daily prices (full, detached / SSH切断耐性)"
    echo "  prices-diff        Fetch daily prices (only new dates)"
    echo "  prices-one DATE    Fetch daily prices for one date (YYYY-MM-DD)"
    echo "  backtest --strategy SMA_CROSS|RSI_MEAN_REVERSION|MACD_CROSS --universe ... --from ... --to ..."
    echo "                     Run a backtest and persist results to backtest_runs/_trades/_equity"
    echo "  notify [--conditions ... --universe ... --params ... --date ... --dry-run]"
    echo "                     Detect signals on the latest trade_date and POST to Discord webhook"
    echo "  shell              Open shell inside backend (debug)"
    echo "  web-init           Bootstrap Next.js scaffold into ./frontend (run once)"
    echo "  web                Build + start Next.js (production, detached, idempotent)"
    echo "  web-rebuild        Force rebuild + restart (used by CI deploy)"
    echo "  web-logs           Tail Next.js logs"
    echo "  web-stop           Stop and remove Next.js server"
    exit 1
    ;;
esac
