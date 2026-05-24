# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

J-Quants API V2 から日本株データを取得して NAS 上の MariaDB に格納するパイプライン + Next.js 製の閲覧フロントエンド。
ARM64 NAS (TerraMaster TNAS-B4AF, busybox ベース) で Docker コンテナ群として動かす想定。
公開はせずローカル運用、push 検知の self-hosted runner で deploy する CI/CD あり。

ディレクトリ構成:
- `backend/` — Python 製 fetcher (`Dockerfile`, `requirements.txt`, `sql/`, `src/`)
- `frontend/` — Next.js 16 App Router (DB 閲覧用 UI)
- `data/` — fetcher の出力先 (バックエンドだが root 配置 / 共有を想定して切り分け)
- `.github/workflows/deploy.yml`, `setup-runner.sh` — CI/CD
- `run.sh` — backend / frontend どちらも叩く統一ラッパー

## Common commands

実行は `run.sh` (docker run ラッパー)。最初に `./run.sh build` で `stock-worker` イメージを作る必要がある。

```bash
./run.sh build              # Python worker イメージビルド
./run.sh listed             # 銘柄マスタ取得
./run.sh prices             # 日足フル取得 (前景)
./run.sh prices-bg          # 日足フル取得 (デタッチ / SSH切断耐性)
./run.sh prices-diff        # 日足差分取得 (DB の最新日付以降のみ)
./run.sh prices-one DATE    # 1 日だけ取得 (テスト用 / YYYY-MM-DD)
./run.sh shell              # Python worker に bash で入る
./run.sh web-init           # Next.js 雛形を ./frontend に生成 (初回のみ)
./run.sh web                # Next.js dev サーバー起動 (detached, idempotent / port 3000)
./run.sh web-logs           # Next.js dev のログ追跡
./run.sh web-restart        # Next.js dev を再起動
./run.sh web-stop           # Next.js dev を停止
```

`run.sh` は `backend/src/` と `frontend/` をボリュームマウントするので、コード変更は再ビルド不要で即反映される。

テストフレームワーク・リンタは未導入。

### 初回セットアップで必須

- `backend/sql/init.sql` 中の `CHANGE_ME_STRONG_PASSWORD` を実値に置換してから流す (3 箇所)
- `.env` は `.env.example` をコピーして `JQUANTS_API_KEY` と `DB_PASSWORD` を埋める
- CI/CD を有効にする手順は `README.md` の「CI/CD」セクションに集約 (runner image を scp、PAT を発行、`setup-runner.sh` 実行)

## Architecture

### 取得戦略: 日付ループ

`/v2/equities/bars/daily` は `date` パラメータで「その日の全銘柄」を 1 リクエストで返す。
`fetch_prices.py` はこの性質を利用して**日付でループ**する (銘柄ループではない)。
5 年で約 1250 営業日、レートリミットを守りやすい。

土日は `weekday() >= 5` でスキップ。祝日はレスポンスが空なので自然にスキップされる。

### V2 API のカラム命名と銘柄コード変換

V2 はカラム名が短縮形 (`O`, `H`, `L`, `C`, `Vo`, `Va`, `AdjO`, `AdjFactor`, ...)。
`backend/src/fetch_prices.py` / `backend/src/fetch_listed.py` の `COLUMN_MAP` で DB のスネークケースカラムにリネームしている。
プラン差で出ないカラムを許容するため、`available = {k: v for k, v in COLUMN_MAP.items() if k in df.columns}` でフィルタしてからリネーム。

**銘柄コードは「5桁の末尾0」だけを採用して 4 桁に切り詰める**。J-Quants V2 のコードは「4桁ベース + 種別1桁」構造で、優先株/種類株/ETF複数クラスなどが同じ 4 桁ベースで衝突するため、末尾 `0` (普通株) 以外は捨てる方針 (`backend/src/fetch_listed.py`, `backend/src/fetch_prices.py`)。新形式の `130A` などアルファベット混じりコードも `130A0` → `130A` のルールに乗る。

調整済み株価は `adjustment_*` (split/併合反映済み)。バックテストはこちらを使う前提。

### レート制御はクライアント側に集約

`JQuantsClient._throttle()` がリクエスト単位で 1.1 秒間隔 (60req/分 = Light プラン上限) を保証する。
ページネーション中も `_get()` 呼び出しごとにスロットルされるので、4xx/429 が原理的に起きない。
プラン上げる場合は `JQUANTS_RATE_PER_MIN` 環境変数で調整可能。

`fetch_prices.py` 側には sleep を入れない (二重律速の解消)。
429 のリトライ (15 秒 + tenacity 指数バックオフ) は安全網として残してあるが、通常パスでは触らない。

### 再実行性

`daily_quotes` の主キーは `(code, trade_date)`。`INSERT IGNORE` で重複弾く設計なので、途中で落ちても同じ範囲を再実行すれば続行できる。差分モード (`FETCH_MODE=diff`) は `SELECT MAX(trade_date)` を起点にする。

pymysql は `NaN` を受け付けない (`nan can not be used with MySQL`)。一部銘柄 (出来高 0 やストップ高/安、上場直後の `adjustment_*` 未確定等) が NaN を持つので、`insert_quotes` で `pd.isna(v)` を見て `None` に倒している (`backend/src/fetch_prices.py`)。

### DB レイヤ

`db.py` の `get_engine()` は SQLAlchemy エンジンを返すだけ。`pool_pre_ping=True` と `pool_recycle=3600` を入れているのは、長時間ジョブ中に接続が切れた場合の自動復旧のため。

`network_mode: host` で動かすので、コンテナ内からも `DB_HOST=127.0.0.1` で繋がる。LAN 内ホストから直で動かす場合は `192.168.10.%` ユーザーが使われる (init.sql 参照)。

### fetch_log の使い方

`fetch_log` テーブルはジョブの履歴管理。`job_type` で種別 (`listed_info` / `daily_quotes` (個別日付エラー) / `daily_quotes_bulk` (バルク完了サマリ)) を区別する。差分ジョブのトラブルシューティングはまずここを見る。

### Web (Next.js)

`./run.sh web-init` で `frontend/` 配下に Next.js 16 App Router 製の雛形が生成される (TS, no Tailwind, no src dir, Turbopack, app router)。
`./run.sh web` は dev サーバーを `--network host` で起動 (`-H 0.0.0.0` で LAN 公開)。`-d --restart unless-stopped` で常駐 (SSH 切断 / NAS 再起動でも生存)、既に動いていれば no-op なので deploy.yml から毎回叩いても安全。

DB アクセスは Server Component から直接 `mysql2/promise` で行う想定 (API route は不要)。
DB 接続情報は `--env-file .env` でコンテナに注入され、`process.env.DB_*` で参照する。

`node_modules` と `.next` は名前付き volume (`stock-web-node-modules`, `stock-web-next-cache`) に逃がして、ホスト側 (SMB 共有経由) の I/O 詰まりを回避している。`frontend/node_modules/` と `frontend/.next/` はホストには存在しない (= git にも CI rsync にも乗らない)。

## Deployment / CI/CD

`main` への push で NAS 上の self-hosted runner (`stock-runner` コンテナ) が起動。

ワークフロー (`.github/workflows/deploy.yml`):
1. `actions/checkout` で runner 内部の workspace にコード取得
2. `rsync` で `$NAS_WORKSPACE` (= NAS の `/mnt/public/develop/stock/`) に展開
3. `.env`, `data/`, `frontend/node_modules/`, `frontend/.next/` 等は除外 (NAS 側の値を保持)
4. `bash $NAS_WORKSPACE/run.sh web` で Next.js dev を ensure (既に動いていれば no-op)

**`$NAS_WORKSPACE` が何故必要か (DinD sibling container の罠)**:
runner は `docker.sock` をマウントして sibling container を spawn する設計。runner 内で
`run.sh` が走ると `docker run -v $SCRIPT_DIR/frontend:/app` を発行するが、この volume
パスはホスト Docker daemon が解釈するためホスト視点のパスでないといけない。
そこで `setup-runner.sh` は `-v "${SCRIPT_DIR}:${SCRIPT_DIR}"` (同パスマウント) と
`-e NAS_WORKSPACE="${SCRIPT_DIR}"` を runner に渡し、deploy.yml は `$NAS_WORKSPACE`
配下のパスで rsync / run.sh invoke している。これで runner 内とホストでパスが一致して
sibling container の volume mount が成立する。

**自動再起動の方針**:
- Next.js dev は deploy 後に `./run.sh web` を ensure 呼びするが、既起動なら no-op で fast-refresh に任せる
- 長時間バッチ (`stock-prices` 等) は実行途中なら割り込みたくないので手動 `docker restart` で対応
- `Dockerfile` / `requirements.txt` を変えた時は手動で `./run.sh build` し直す

runner は `myoung34/github-runner:latest` (ARM64) を docker save/scp/load で持ち込み、`docker.sock` と `/mnt/public/develop/stock/` をマウントして常駐させている。`setup-runner.sh` がそのセットアップを担う。

`ACCESS_TOKEN` (PAT) 方式で起動しており、起動時にイメージ自身が registration token を発行して登録する。短期失効する `RUNNER_TOKEN` (1h) は使っていないので、NAS 再起動・コンテナ再作成・GitHub 側 deregister のいずれの場合も `docker restart stock-runner` だけで自動復旧する。PAT 失効時のみ `setup-runner.sh` を新 PAT で再実行する。

## NAS 環境の制約

このプロジェクトは TerraMaster NAS (busybox ベース、ARM64) で動く前提があり、以下が **使えない**:

- `docker compose` (中途半端な python interpreter が壊れてる) → `docker run` ベースの `run.sh` 必須
- `nohup` / `screen` → デタッチが必要なジョブは `docker run -d` + `--restart` で対応 (`prices-bg`, `stock-runner`)
- **Docker image を NAS で pull できない** → Windows で `docker pull` → `docker save | gzip` → `scp` → NAS で `docker load`
- システムに git/rsync/その他のツールがほぼ無い → 必要なら image 内で完結させる (runner image が git/rsync を内包しているのを利用)

`network_mode: host` は LAN 内 MariaDB に繋ぐためで、SMB 経由のホスト I/O も同じネットワークスタックを通る。

## メモリ運用上の注意

- 課金前提のサービス (cloud DB、有料 VPS 等) は積極的に提案しない。`memory/project_local_only.md` 参照
- J-Quants は Light プラン。`FETCH_YEARS=5` がデフォルト、レート 60req/分。`memory/project_jquants_plan.md` 参照
- GitHub repo は `deltaebisen/stock` (private)。`memory/reference_github_repo.md` 参照
