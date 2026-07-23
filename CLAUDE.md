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
./run.sh calendar           # 営業日カレンダー取得 (full)
./run.sh calendar-diff      # 営業日カレンダー差分取得 (月次運用想定)
./run.sh edinet-codes       # EDINET 事業者コード (証券コード↔EDINETコード) 取得
./run.sh edinet-docs        # EDINET 提出書類メタ (5 年分) 取得 (前景)
./run.sh edinet-docs-bg     # 同 (デタッチ / 30 分〜)
./run.sh edinet-docs-diff   # EDINET 提出書類メタ差分取得
./run.sh xbrl               # 未 parse な edinet_documents の XBRL を financial_facts に展開 (前景)
./run.sh xbrl-bg            # 同 (デタッチ / 長時間)
./run.sh prices             # 日足フル取得 (前景)
./run.sh prices-bg          # 日足フル取得 (デタッチ / SSH切断耐性)
./run.sh prices-diff        # 日足差分取得 (DB の最新日付以降のみ)
./run.sh prices-one DATE    # 1 日だけ取得 (テスト用 / YYYY-MM-DD)
./run.sh backtest --strategy ... --universe ... --from DATE --to DATE
                            # バックテスト実行 → backtest_runs/_trades/_equity に永続化
./run.sh shell              # Python worker に bash で入る
./run.sh web-init           # Next.js 雛形を ./frontend に生成 (初回のみ)
./run.sh web                # Next.js を build + start で常駐起動 (idempotent / port 3000)
./run.sh web-rebuild        # 強制再 build + 再起動 (CI deploy が叩く)
./run.sh web-logs           # Next.js のログ追跡
./run.sh web-stop           # Next.js を停止
```

`run.sh` は `backend/src/` と `frontend/` をボリュームマウントするので、コード変更は再ビルド不要で即反映される。

テストフレームワーク・リンタは未導入。

### 初回セットアップで必須

- `backend/sql/init.sql` 中の `CHANGE_ME_STRONG_PASSWORD` を実値に置換してから流す (3 箇所)
- `.env` は `.env.example` をコピーして `JQUANTS_API_KEY` / `EDINET_API_KEY` / `DB_PASSWORD` を埋める (NAS 側では追加で `RUNNER_PAT` も埋める — CI/CD 用)
- CI/CD を有効にする手順は `README.md` の「CI/CD」セクションに集約 (runner image を scp、PAT を発行、`setup-runner.sh` 実行)

## Architecture

### 取得戦略: 日付ループ

`/v2/equities/bars/daily` は `date` パラメータで「その日の全銘柄」を 1 リクエストで返す。
`fetch_prices.py` はこの性質を利用して**日付でループ**する (銘柄ループではない)。
5 年で約 1250 営業日、レートリミットを守りやすい。

営業日判定は **`trading_calendar` テーブルを SELECT** して `is_trading=1` の日付 set を作り、それ以外は skip。テーブルが空の場合 (初回 / `./run.sh calendar` 未実行) は `weekday() >= 5` フォールバック + 祝日はレスポンス空で自然スキップ。

`trading_calendar` は `/v2/markets/trading_calendar` から取得 (`HolidayDivision`: '0'=非営業日 / '1'=営業日 / '2'=東証半日立会 / '3'=祝日取引可能日)。半日立会も日足は出るので `'1' or '2'` を `is_trading=1` として保存。`./run.sh calendar` で過去 5 年 + 翌年末まで取得、運用中は `./run.sh calendar-diff` で月次更新する想定 (祝日は前年に公開されるため翌年分まで先取り)。

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

`fetch_log` テーブルはジョブの履歴管理。`job_type` で種別 (`listed_info` / `daily_quotes` (個別日付エラー) / `daily_quotes_bulk` (バルク完了サマリ) / `edinet_code_mapping` / `edinet_documents` / `edinet_documents_bulk` / `xbrl_parse_bulk`) を区別する。差分ジョブのトラブルシューティングはまずここを見る。

### EDINET 連携 (財務指標用)

J-Quants Light プランでは時価総額 / PER / PBR / EPS / BPS / ROE 等が取れないので、金融庁 EDINET (無料) から XBRL を取得して財務情報を埋める。3 段階構成:

1. **`edinet_code_mapping`** (`./run.sh edinet-codes`)
   - EDINET 公式 ZIP (Shift-JIS CSV) を直 URL から取得 → 証券コード ↔ EDINET コード (E########) の対応表
   - 週次更新で十分。`/equities/master` の 4 桁証券コードと JOIN するときは末尾 0 を切って正規化する (J-Quants 側と同ルール)

2. **`edinet_documents`** (`./run.sh edinet-docs[-bg|-diff]`)
   - `/api/v2/documents.json` を日付ループで回して提出書類メタを蓄積
   - 5 年フル ≈ 1800 リクエスト × 1 秒 = 30 分。SSH 切断耐性は `edinet-docs-bg`
   - `parsed_at` カラム NULL のレコードを `parse_xbrl` が拾って財務化する

3. **`financial_facts`** (`./run.sh xbrl[-bg]`、`backend/src/parse_xbrl.py`)
   - 未 parse な `edinet_documents` を 1 件ずつ EDINET API `/documents/{docID}?type=1` で ZIP DL
   - ZIP 内 `XBRL/PublicDoc/*.xbrl` (無ければ `*.htm` iXBRL fallback) を **`arelle` (XBRL 2.1 reference implementation)** で load
     - DTS (schema + linkbase) を辿って concept type / dimension / unit を完全解決
     - tuple 子要素は `modelTupleFacts` を再帰展開してフラットに出す
     - fraction (numerator/denominator) は arelle の `fact.fractionValue` から計算済み値を入れる
   - 全ファクトを 1 行 1 ファクトの **EAV テーブル `financial_facts`** に投入 (`(doc_id, element_id, context_ref)` PK)
   - フラットなワイドテーブルではなく EAV にした理由: J-GAAP / IFRS で要素名が異なり、連結/単体/前期/前々期 等のコンテキスト次元が爆発するため、ワイドだと無限に列が増える。EAV なら 1 スキーマで全部入る + frontend では view か materialized table で必要な部分だけ pivot すればいい
   - 数値ファクト (numeric concept) → `value_num` (DECIMAL(28,4))、それ以外 (date / boolean / string / DEI 系) → `value_text` (MEDIUMTEXT)
   - 各 fact には `item_type` (concept の XBRL item type: `monetaryItemType` / `sharesItemType` / `pureItemType` / `dateItemType` 等) を保持。screening 時に「monetary だけ」「per-share だけ」で絞るときに使う
   - `unit_ref` は arelle が解決した unit 文字列 (`iso4217:JPY` / `xbrli:shares` / `iso4217:JPY/xbrli:shares` (per-share))
   - **`textBlockItemType` または element 名末尾 `TextBlock` はスキップ**。screening 用途では使わないし textBlock は容量を食う割に検索性が低い
   - element_id は `prefix:localname` 形式 (例: `jppfs_cor:NetSales` / `jpdei_cor:AccountingStandardsDEI`)。prefix が無い名前空間 (極稀) は `{URI}local` で識別
   - 対象 doc_type_code は `120` (有価証券報告書), `130` (訂正有報), `140`/`150` (四半期/訂正、廃止予定), `160`/`170` (半期/訂正)。`DOC_TYPES` 環境変数で絞れる
   - `parsed_at` を見て自然に差分実行になる (失敗した doc も `parse_error` を残したうえで `parsed_at` を立てるので、リトライしたい場合は `UPDATE edinet_documents SET parsed_at=NULL, parse_error=NULL WHERE parse_error IS NOT NULL`)
   - **初回のスピード**: arelle が DTS 解決時に EDINET 公式タクソノミ (~10MB) を `disclosure2dl.edinet-fsa.go.jp` から HTTP 取得。1 件目だけ 30〜60 秒。同タクソノミバージョンの 2 件目以降は WebCache hit で 5〜10 秒/件
   - **WebCache の永続化**: arelle の cache は `stock-arelle-cache` 名前付き volume にマウント (`/app/data/arelle-cache`)。`ARELLE_CACHE_DIR` で変更可能。コンテナ再作成・image rebuild しても cache 維持
   - **arelle 側の rate limit**: arelle 自身は HTTP fetch に rate limit を持たないので、DTS 解決時に `disclosure2dl.edinet-fsa.go.jp` に 5〜10 req/sec で burst を打ってしまう。EDINET API v2 側 (EdinetClient) と同等の負荷に揃えるため、`_install_throttled_opener()` で `webCache.opener.open` を **1 req/sec** に絞ってある (`ARELLE_HTTP_MIN_INTERVAL` 秒で調整可、デフォルト 1.0)。cache hit のときは opener が呼ばれないので throttle のオーバーヘッドゼロ
   - 5 年フル parse は doc 数万件 × 5〜10 秒/件 = 数時間〜半日。必ず `xbrl-bg`
   - **smoke test 推奨**: `LIMIT=1 ./run.sh xbrl` で 1 件流して fact 数が数百〜千件程度になることを確認してから bulk へ

EDINET API v2 は **API キーをクエリパラメータ `Subscription-Key` で渡す** (ヘッダではない)。レート制限は明示されてないが安全側で 1 req/sec (`EDINET_RATE_PER_SEC` で調整可)。

### バックテスト

`./run.sh backtest --strategy STRATEGY --universe SPEC --from DATE --to DATE [--params K=V,...]` で実行。`daily_quotes` の `adjustment_*` (split/併合調整済価格) をもとに event-driven シミュレーションを回し、結果を 3 テーブルに永続化する。

- `backtest_runs` — 1 run のメタ + サマリメトリクス (total_return / CAGR / Sharpe / max_drawdown / win_rate / num_trades)。`status` で running/success/error 管理
- `backtest_trades` — 個別取引 (entry/exit/手数料込み pnl)。`run_id` でひも付け
- `backtest_equity` — 日次 equity curve (cash + position market value)、drawdown 列付き

実装は `backend/src/backtest.py` (engine + metrics + storage + CLI) + `backend/src/backtest_strategies.py` (Strategy 基底 + 組込み戦略)。

**v1 のシンプル化前提**:
- long-only、空売り無し
- 既存ポジションへの追加買い無し (同銘柄 buy signal 連発は無視)
- 当日 close で約定 (本来は翌日 open がより正確だが簡略化)
- 等額配分: 同日に複数 entry signal が出たら残現金を新規組数で等分
- 売買単位 100 株等の制約は無視 (1 株単位)
- 手数料は `commission_bps` 片道で近似 (default 10bps = 0.1%)、スリッページもこれに吸収
- universe を `all` (~4000 銘柄) にすると一括クエリで数 GB DataFrame になるので scale_category や explicit codes での絞り込み推奨

**戦略追加方法**: `backtest_strategies.py` に `Strategy` サブクラスを書いて `STRATEGIES` と `DEFAULT_PARAMS` 辞書に登録。`generate_signals(df) -> Series` が +1/-1/0 を返す。

**universe_spec**:
- `all` — listed_info 全銘柄
- `scale:TOPIX Large 70` — scale_category 完全一致
- `codes:7203,9984,1301` — explicit list
- `single:1301` — 1 銘柄ショートカット

**結果の見方** (DB 直叩き例):
```sql
SELECT id, strategy, total_return, cagr, sharpe, max_drawdown, num_trades
  FROM backtest_runs ORDER BY id DESC LIMIT 10;
SELECT * FROM backtest_trades WHERE run_id = N ORDER BY entry_date;
SELECT trade_date, equity, drawdown FROM backtest_equity WHERE run_id = N ORDER BY trade_date;
```

frontend での equity curve 表示 / 戦略パラメータ scan / walk-forward 等は別 PR で。

### Web (Next.js)

`./run.sh web-init` で `frontend/` 配下に Next.js 16 App Router 製の雛形が生成される (TS, no Tailwind, no src dir, Turbopack, app router)。

`./run.sh web` は `npm install && npm run build && npm run start -- -H 0.0.0.0` を `--network host` 上の detached + `--restart unless-stopped` コンテナで動かす。**dev サーバーではなく production build を使う**理由: `next dev` (Turbopack) は TTY 無し環境で stdin EOF を quit シグナルとして扱い、Ready の数秒後に exit 0 で死んで restart loop に陥るため (NAS 上で再現確認済)。`next start` は安定 + メモリ消費も少ない。

`web` は idempotent (既に起動中なら no-op)。CI deploy は `web-rebuild` を叩いて強制再 build + 再起動する。`.next/` は named volume なので Turbopack incremental cache が効いて 2 回目以降の build はそこそこ速い。

DB アクセスは Server Component から直接 `mysql2/promise` で行う想定 (API route は不要)。
DB 接続情報は `--env-file .env` でコンテナに注入され、`process.env.DB_*` で参照する。

`node_modules` と `.next` は名前付き volume (`stock-web-node-modules`, `stock-web-next-cache`) に逃がして、ホスト側 (SMB 共有経由) の I/O 詰まりを回避している。`frontend/node_modules/` と `frontend/.next/` はホストには存在しない (= git にも CI rsync にも乗らない)。

## Deployment / CI/CD

`main` への push で NAS 上の self-hosted runner (`stock-runner` コンテナ) が起動。

ワークフロー (`.github/workflows/deploy.yml`):
1. `actions/checkout` で runner 内部の workspace にコード取得
2. `rsync` で `$NAS_WORKSPACE` (= NAS の `/mnt/public/develop/stock/`) に展開
3. `.env`, `data/`, `frontend/node_modules/`, `frontend/.next/` 等は除外 (NAS 側の値を保持)
4. `bash $NAS_WORKSPACE/run.sh web-rebuild` で Next.js を強制再 build + 再起動 (新コード反映)

**`$NAS_WORKSPACE` が何故必要か (DinD sibling container の罠)**:
runner は `docker.sock` をマウントして sibling container を spawn する設計。runner 内で
`run.sh` が走ると `docker run -v $SCRIPT_DIR/frontend:/app` を発行するが、この volume
パスはホスト Docker daemon が解釈するためホスト視点のパスでないといけない。
そこで `setup-runner.sh` は `-v "${SCRIPT_DIR}:${SCRIPT_DIR}"` (同パスマウント) と
`-e NAS_WORKSPACE="${SCRIPT_DIR}"` を runner に渡し、deploy.yml は `$NAS_WORKSPACE`
配下のパスで rsync / run.sh invoke している。これで runner 内とホストでパスが一致して
sibling container の volume mount が成立する。

**自動再起動の方針**:
- Next.js は deploy のたびに `./run.sh web-rebuild` で再 build + 再起動 (production build なので fast-refresh は無く、deploy = 完全リフレッシュ)
- 長時間バッチ (`stock-prices` 等) は実行途中なら割り込みたくないので手動 `docker restart` で対応
- `Dockerfile` / `requirements.txt` を変えた時は手動で `./run.sh build` し直す (deploy workflow は `web-rebuild` しかしないので worker イメージは更新されない。`ModuleNotFoundError` が CI で出たらこれを疑う)

python worker は `run.sh` で `--memory ${WORKER_MEMORY:-1g}` を付けて起動する。上限が無いとメモリを食い潰したときにホストの OOM killer が RSS 最大のプロセスを選ぶので、無関係なコンテナ (実際に `stock-runner`) が巻き添えになる。cgroup 上限があれば被害がジョブ 1 本に閉じる。空きメモリに応じて `WORKER_MEMORY=2g ./run.sh ...` で調整。

runner は `myoung34/github-runner:latest` (ARM64) を docker save/scp/load で持ち込み、`docker.sock` と `/mnt/public/develop/stock/` をマウントして常駐させている。`setup-runner.sh` がそのセットアップを担う。

`ACCESS_TOKEN` (PAT) 方式で起動しており、起動時にイメージ自身が registration token を発行して登録する。短期失効する `RUNNER_TOKEN` (1h) は使っていないので、NAS 再起動・コンテナ再作成・GitHub 側 deregister のいずれの場合も `docker restart stock-runner` だけで自動復旧する。PAT 失効時のみ `setup-runner.sh` を再実行する。

**runner reusage (`CONFIGURED_ACTIONS_RUNNER_FILES_DIR=/runner-files` + named volume `stock-runner-config` + `DISABLE_AUTOMATIC_DEREGISTRATION=true`) は `--restart always` と組で必須**。myoung34/github-runner の entrypoint は起動のたびに `config.sh` を走らせる (コンテナ使い捨て前提) ので、reusage 無効だと再起動時に `Cannot configure the runner because it is already configured.` → `Value cannot be null. (Parameter 'configuredSettings')` で即 exit → restart policy が再起動、の無限ループに入り二度と復帰しない。この状態になると GitHub 側で runner が offline のまま scheduled workflow が queued で溜まり、24h でタイムアウト cancel される (2026-07 に 4 日ぶん daily batch を落とした)。**runner が offline で復帰しないときは、まず `docker logs stock-runner` でこのループになっていないか見る**。当座の復旧は `setup-runner.sh` を叩き直す (コンテナと設定 volume を作り直すので fresh に再登録される)。

PAT は CLI 引数ではなく **`.env` の `RUNNER_PAT` から読む** (`setup-runner.sh` 内で `source .env`)。`.env` は gitignore 済 & CI rsync 除外で NAS local 保持なので、bash history や `docker inspect stock-runner` への漏出を避けられる。GitHub Actions secrets は runner 自身を起動する場面では使えない (runner が無いと workflow が走らないため chicken-and-egg)。

## NAS 環境の制約

このプロジェクトは TerraMaster NAS (busybox ベース、ARM64) で動く前提があり、以下が **使えない**:

- `docker compose` (中途半端な python interpreter が壊れてる) → `docker run` ベースの `run.sh` 必須
- `nohup` / `screen` → デタッチが必要なジョブは `docker run -d` + `--restart` で対応 (`prices-bg`, `stock-runner`)
- **Docker image を NAS で pull できない** → Windows で `docker pull` → `docker save | gzip` → `scp` → NAS で `docker load` (scp 先は `~/`、`/mnt/public/develop/stock/` は CI 由来の uid で書き込み不可)。持ち込むイメージは現状 `myoung34/github-runner` (CI runner) と `node:22-bookworm-slim` (Next.js ランタイム) の 2 つ
- **Next.js は alpine ではなく debian 系を使う** (`node:22-bookworm-slim`)。`node:22-alpine` (musl-arm64) では SWC の prebuilt native binary が SIGBUS で死んで `next build` が完走しない。glibc-arm64 の prebuilt は安定実績ありなので debian に倒している
- システムに git/rsync/その他のツールがほぼ無い → 必要なら image 内で完結させる (runner image が git/rsync を内包しているのを利用)

`network_mode: host` は LAN 内 MariaDB に繋ぐためで、SMB 経由のホスト I/O も同じネットワークスタックを通る。

## メモリ運用上の注意

- 課金前提のサービス (cloud DB、有料 VPS 等) は積極的に提案しない。`memory/project_local_only.md` 参照
- J-Quants は Light プラン。`FETCH_YEARS=5` がデフォルト、レート 60req/分。`memory/project_jquants_plan.md` 参照
- GitHub repo は `deltaebisen/stock` (private)。`memory/reference_github_repo.md` 参照
