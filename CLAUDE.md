# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

J-Quants API V2 から日本株の日足データを取得して MariaDB に格納するパイプライン。
NAS 上の Docker で動かす想定で、ホストの MariaDB に `network_mode: host` 経由で接続する構成。

## Common commands

実行は `run.sh` (docker run ラッパー) 経由が主。最初に `./run.sh build` で `stock-worker` イメージを作る必要がある。

```bash
./run.sh build         # イメージビルド
./run.sh listed        # 銘柄マスタ取得 (listed_info に TRUNCATE → INSERT)
./run.sh prices        # 日足フル取得 (FETCH_MODE=full, デフォルト5年 / Light プラン上限)
./run.sh prices-diff   # 日足差分取得 (FETCH_MODE=diff, DBの最新日付以降)
./run.sh shell         # コンテナに入って調査
```

compose 環境がある場合は `docker compose run --rm worker python -m src.fetch_listed` 形式でも可。
`run.sh` は `src/` をボリュームマウントするので、コード変更は再ビルド不要で反映される。

テストフレームワークやリンタは未導入。

### 初回セットアップで必須の手順

`sql/init.sql` は `CHANGE_ME_STRONG_PASSWORD` というプレースホルダを 3 箇所含む。
実行前に必ず実パスワードに置換すること。置換せずに走らせるとプレースホルダがそのまま MariaDB のパスワードになる。

`.env` は `.env.example` をコピーして `JQUANTS_API_KEY` と `DB_PASSWORD` を埋める。

## Architecture

### 取得戦略: 日付ループ

`/v2/equities/bars/daily` は `date` パラメータで「その日の全銘柄」を1リクエストで返す。
`fetch_prices.py` はこの性質を利用して**日付でループ**する (銘柄ループではない)。
10年分でも約 2500 リクエスト程度に収まり、レートリミットを守りやすい。

土日は `weekday() >= 5` でスキップ。祝日はレスポンスが空なので自然にスキップされる。

### V2 API のカラム命名

V2 はカラム名が短縮形 (`O`, `H`, `L`, `C`, `Vo`, `Va`, `AdjO`, `AdjFactor`, ...)。
`fetch_prices.py` と `fetch_listed.py` の `COLUMN_MAP` で DB のスネークケースカラムにリネームしている。
プラン差で出ないカラムは `available = {k: v for k, v in COLUMN_MAP.items() if k in df.columns}` で落とすので、新カラム追加時もこのパターンを維持する。

調整済み株価は `adjustment_*` (split/併合反映済み)。バックテストはこちらを使う前提。

### 再実行性

`daily_quotes` の主キーは `(code, trade_date)`。`INSERT IGNORE` で重複弾く設計なので、途中で落ちても同じ範囲を再実行すれば続行できる。差分モード (`FETCH_MODE=diff`) は `SELECT MAX(trade_date)` を起点にする。

### エラー処理とレートリミット

- `jquants_client.py`: `tenacity` で `requests.exceptions.RequestException` を 5 回まで指数バックオフ。429 を受けたら本体側で 15 秒待ち → リトライへ委譲。
- `fetch_prices.py`: 各日付ごとに `time.sleep(1.2)` (Light プラン 60 req/min 想定)。日付単位の失敗は `fetch_log` に `error` 行を残してループ継続。バルク全体の集計行は最後に1行入る。

レートリミットに当たり始めたら `time.sleep(1.2)` を増やす方向で対応する (`fetch_prices.py:99`)。

### DB レイヤ

`db.py` の `get_engine()` は SQLAlchemy エンジンを返すだけ。`pool_pre_ping=True` と `pool_recycle=3600` を入れているのは、長時間ジョブ中に接続が切れた場合の自動復旧のため。

`network_mode: host` で動かすので、コンテナ内からも `DB_HOST=127.0.0.1` で繋がる。LAN 内ホストから直で動かす場合は `192.168.10.%` ユーザーが使われる (init.sql 参照)。

### fetch_log の使い方

`fetch_log` テーブルは ジョブの履歴管理。`job_type` で種別 (`listed_info` / `daily_quotes` (個別日付エラー) / `daily_quotes_bulk` (バルク完了サマリ)) を区別する。差分ジョブのトラブルシューティングはまずここを見る。
