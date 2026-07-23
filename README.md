# 株式検証基盤 - データ取得パイプライン (J-Quants API V2 対応)

J-Quants API V2から日足データを取得してMariaDBに格納する。

## 構成

```
stock/
├── run.sh                  # docker runラッパースクリプト (推奨)
├── setup-runner.sh         # GitHub Actions self-hosted runner 起動
├── .env.example            # 環境変数テンプレート
├── .env                    # 実際の認証情報 (gitignore)
├── .github/workflows/
│   └── deploy.yml          # push 時に NAS へ rsync するワークフロー
├── backend/                # Python fetcher
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── requirements.txt
│   ├── sql/init.sql        # DB・ユーザー・テーブル作成SQL
│   └── src/
│       ├── jquants_client.py
│       ├── db.py
│       ├── fetch_listed.py
│       └── fetch_prices.py
└── frontend/               # Next.js 16 App Router (web UI)
    ├── app/
    ├── package.json
    └── ...
```

## セットアップ手順

### 1. APIキー発行

https://jpx-jquants.com/ja/dashboard でAPIキーを発行。

### 2. 初期化SQL実行

`backend/sql/init.sql` 内のパスワードを実際の値に書き換えてから:

```bash
mysql -u root -p < backend/sql/init.sql
```

### 3. .env作成

```bash
cp .env.example .env
vi .env
```

埋める項目:
- `JQUANTS_API_KEY`: ダッシュボードで発行したAPIキー
- `DB_PASSWORD`: init.sqlで設定したstockuserのパスワード

## 実行 (docker run版 - 推奨)

`run.sh` で全部できる:

```bash
# 1. イメージビルド
./run.sh build

# 2. 銘柄マスタ取得 (まず疎通確認)
./run.sh listed

# 3. 営業日カレンダー取得 (祝日判定用 / 過去 5 年 + 翌年末まで)
./run.sh calendar

# 4. 日足フル取得 (時間かかる)
./run.sh prices

# 日次差分更新
./run.sh calendar-diff   # 月次でも可
./run.sh prices-diff

# コンテナ内に入って調査
./run.sh shell
```

## 実行 (docker compose版 - 環境が揃ってる場合)

```bash
cd backend
docker compose build
docker compose run --rm worker python -m src.fetch_listed
docker compose run --rm worker python -m src.fetch_prices
docker compose run --rm -e FETCH_MODE=diff worker python -m src.fetch_prices
```

## 長時間処理のバックグラウンド実行

日足フル取得は1時間以上かかる。SSH切断で止まらないように `./run.sh prices-bg` を使う:

```bash
./run.sh prices-bg                # detached で起動 (SSH切断後も継続)
docker logs -f stock-prices       # ログ追跡
docker ps -a --filter name=stock-prices    # 状態確認
docker stop stock-prices          # 停止
```

NAS の busybox 環境では `nohup` / `screen` が無いので、Docker デーモンに管理を任せるこの方式が確実。

## CI/CD (GitHub Actions self-hosted runner)

push 検知で NAS が自分で `git fetch` 相当のことをして `/mnt/public/develop/stock/` を更新する。
runner は NAS の Docker 内で動く (NAS 本体には何もインストール不要)。

### 初回セットアップ

**1. GitHub に private repo を作って push**

Windows 側 (このリポジトリのトップで):
```bash
git init
git add .
git commit -m "initial"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

**2. runner image と node image を NAS に持ち込み**

NAS は docker pull できないので、Windows 側で pull → save → scp → NAS で load する。
`/mnt/public/develop/stock/` は CI 由来の所有権で `shoootake` 書き込み不可なので
home (`~/`) に scp してから load する。

Windows 側で:
```bash
# 1. GitHub Actions runner
docker pull --platform linux/arm64 myoung34/github-runner:latest
docker save myoung34/github-runner:latest | gzip > github-runner.tar.gz
scp -P 9222 github-runner.tar.gz shoootake@192.168.10.2:~/

# 2. Next.js 用 node ランタイム (alpine の musl-arm64 だと SWC が SIGBUS で死ぬので debian)
docker pull --platform linux/arm64 node:22-bookworm-slim
docker save node:22-bookworm-slim | gzip > node22-bookworm-slim-arm64.tar.gz
scp -P 9222 node22-bookworm-slim-arm64.tar.gz shoootake@192.168.10.2:~/
```

NAS 側で:
```bash
gunzip -c ~/github-runner.tar.gz | docker load
gunzip -c ~/node22-bookworm-slim-arm64.tar.gz | docker load
rm ~/github-runner.tar.gz ~/node22-bookworm-slim-arm64.tar.gz
```

**3. PAT (Personal Access Token) を発行**

GitHub > 右上アバター > Settings > Developer settings > Personal access tokens >
**Fine-grained tokens** > Generate new token:

- Resource owner: `deltaebisen` (対象 repo の owner)
- Repository access: **Only select repositories** → 対象 repo のみ
- Repository permissions: **Administration: Read and write**
- Expiration: 任意 (無期限 or 1 年)

発行された `github_pat_...` を NAS の `.env` に追記:
```
RUNNER_PAT=github_pat_xxxxxxxxxxxxxxxxxxxx
```

`.env` は gitignore 済 & CI rsync 除外で NAS local。CLI 引数で渡すと bash history や
`docker inspect` に漏れるので、`.env` 経由で読ませる流儀にしている (DB_PASSWORD と同じ)。

短期失効する registration token (1h) ではなく PAT を使うことで、コンテナ再起動・NAS 再起動・
GitHub 側で deregister されたケースも、起動時に自動で再登録される (毎回 token 取り直し不要)。

なお runner コンテナは `CONFIGURED_ACTIONS_RUNNER_FILES_DIR` (runner reusage) を有効にして
設定を named volume `stock-runner-config` に永続化している。これが無いと再起動のたびに
`Cannot configure the runner because it is already configured.` で落ちて `--restart always`
と無限ループになり、runner が offline のまま復帰しない。詳細は `setup-runner.sh` の注 3。

**4. runner 起動**

```bash
./setup-runner.sh <owner>/<repo>     # PAT は .env から読まれる
docker logs -f stock-runner          # "Listening for Jobs" が出れば成功
```

GitHub repo > Settings > Actions > Runners の画面で `nas-runner` が **Idle** に
なっていれば登録完了。以降は触らなくて良い。

### 動作確認

Windows 側で何か変更してコミット → push:
```bash
git commit -am "test deploy"
git push
```

GitHub repo > Actions タブで Deploy ワークフローが走るのが見える。完了後、NAS の
`/mnt/public/develop/stock/` に変更が反映されてる。

### 既知の運用ノート

- `.env` と `data/` は workflow の rsync 対象外。NAS 側の値が保持される
- 長時間ジョブ (例: `./run.sh prices-bg`) は deploy では自動再起動されない。コード変更を
  反映させたい時は手動で `docker restart stock-prices` する
- Next.js (`./run.sh web`) は production build → start を detached + `--restart unless-stopped` で常駐。
  deploy は `./run.sh web-rebuild` を叩いて毎回再 build + 再起動 (fast-refresh は無く完全リフレッシュ)。
  next dev は NAS の TTY 無し環境で stdin EOF を quit と解釈して死ぬので production build を採用。
  手動操作は `./run.sh web-logs|web-rebuild|web-stop` で
- `Dockerfile` や `requirements.txt` を変えた時だけ手動で `./run.sh build` し直す

## 設計メモ

### 日付ループ vs 銘柄ループ

`/v2/equities/bars/daily` は `date` パラメータでその日の全銘柄を1リクエストで取れる。
日付ループ採用 (約2500リクエスト / 10年)。

### レートリミット対応

Lightプランは60 req/min。`time.sleep(1.2)` で抑制。429はクライアント側で15秒待ってリトライ。

### 重複排除

`daily_quotes` は主キー `(code, trade_date)` で INSERT IGNORE。途中で止まっても再実行で続行可能。

### 株価調整

`adjustment_*` カラムに分割・併合調整済みの値が入る。バックテスト時はこちらを使う。

## トラブルシューティング

### docker compose が動かない

`docker-compose` の python interpreter が壊れてる場合あり (TerraMasterの一部環境)。
→ `run.sh` を使う (docker runベース)。

### DB接続エラー

- network_mode: host で動かしてるので `DB_HOST=127.0.0.1` 推奨
- ユーザーのhost制限確認: `SELECT user, host FROM mysql.user WHERE user='stockuser';`

### J-Quants認証エラー (401)

- APIキーが正しいか確認
- ヘッダー名は `x-api-key` (小文字)

### レートリミット (429)

- `time.sleep` を増やす or プランをアップグレード
