-- ============================================================
-- 株式検証基盤 初期化SQL (J-Quants API V2 対応)
-- 実行: mysql -u root -p < sql/init.sql
-- 注意: 'CHANGE_ME_STRONG_PASSWORD' を実際のパスワードに書き換えてから実行
-- ============================================================

-- DB作成
CREATE DATABASE IF NOT EXISTS stock_research
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ユーザー作成（LAN内のみ許可）
CREATE USER IF NOT EXISTS 'stockuser'@'192.168.10.%'
  IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON stock_research.* TO 'stockuser'@'192.168.10.%';

-- Dockerコンテナ用(network_mode: host なので127.0.0.1経由)
CREATE USER IF NOT EXISTS 'stockuser'@'127.0.0.1'
  IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON stock_research.* TO 'stockuser'@'127.0.0.1';

CREATE USER IF NOT EXISTS 'stockuser'@'localhost'
  IDENTIFIED BY 'CHANGE_ME_STRONG_PASSWORD';
GRANT ALL PRIVILEGES ON stock_research.* TO 'stockuser'@'localhost';

FLUSH PRIVILEGES;

USE stock_research;

-- ============================================================
-- 銘柄マスタ (V2: /equities/master)
-- ============================================================
CREATE TABLE IF NOT EXISTS listed_info (
  code VARCHAR(10) PRIMARY KEY,
  info_date DATE,
  company_name VARCHAR(255),
  company_name_english VARCHAR(255),
  sector17_code VARCHAR(10),
  sector17_name VARCHAR(100),
  sector33_code VARCHAR(10),
  sector33_name VARCHAR(100),
  scale_category VARCHAR(50),
  market_code VARCHAR(10),
  market_name VARCHAR(100),
  margin_code VARCHAR(10),
  margin_name VARCHAR(50),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_market (market_code),
  INDEX idx_sector17 (sector17_code),
  INDEX idx_sector33 (sector33_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 日足 (V2: /equities/bars/daily)
-- ============================================================
CREATE TABLE IF NOT EXISTS daily_quotes (
  code VARCHAR(10) NOT NULL,
  trade_date DATE NOT NULL,
  open DECIMAL(12,2),
  high DECIMAL(12,2),
  low DECIMAL(12,2),
  close DECIMAL(12,2),
  volume BIGINT,
  turnover_value BIGINT,
  adjustment_factor DECIMAL(12,6),
  adjustment_open DECIMAL(12,2),
  adjustment_high DECIMAL(12,2),
  adjustment_low DECIMAL(12,2),
  adjustment_close DECIMAL(12,2),
  adjustment_volume BIGINT,
  PRIMARY KEY (code, trade_date),
  INDEX idx_date (trade_date),
  -- 日付レンジで全銘柄を舐める用途 (frontend の業種別リターン / 相対強度) のカバリング
  -- インデックス。idx_date だけだと PK へのランダムアクセスが発生し、1 年ぶんのスキャンに
  -- 90 秒かかっていた (5.4M 行 / NAS)。close と adjustment_factor まで載せて index-only にする
  INDEX idx_date_code_px (trade_date, code, close, adjustment_factor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 営業日カレンダー (V2: /markets/trading_calendar)
-- holiday_division: '0'=非営業日 / '1'=営業日 / '2'=東証半日立会 / '3'=祝日取引可能日
-- is_trading は '1' or '2' のとき TRUE (半日立会も日足は出るので営業日扱い)
-- ============================================================
CREATE TABLE IF NOT EXISTS trading_calendar (
  trade_date DATE PRIMARY KEY,
  holiday_division CHAR(1) NOT NULL,
  is_trading TINYINT(1) NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_is_trading (is_trading)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- EDINET コードマッピング (証券コード <-> EDINET コード)
-- ソース: https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip
-- 週次で全量上書き想定 (件数は数万件で軽量)
-- ============================================================
CREATE TABLE IF NOT EXISTS edinet_code_mapping (
  edinet_code CHAR(6) PRIMARY KEY,           -- E########
  sec_code VARCHAR(10),                       -- 5桁または4桁。listed_info と JOIN するときは末尾0切って4桁化
  filer_name VARCHAR(255),
  filer_name_en VARCHAR(255),
  filer_type VARCHAR(50),                     -- 提出者種別
  listed_division VARCHAR(50),                -- 上場区分
  industry VARCHAR(100),
  corp_number VARCHAR(13),                    -- 法人番号
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_sec_code (sec_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- EDINET 提出書類メタ (XBRL 本体は parse 後ファクトとして financial_facts に展開、本テーブルは index)
-- 日付ループで /api/v2/documents.json から取得。
-- doc_type_code:
--   120=有価証券報告書、130=訂正有価証券報告書、140=四半期報告書(廃止予定)、
--   150=訂正四半期報告書、160=半期報告書、170=訂正半期報告書、180=臨時報告書、...
-- parsed_at NULL かつ xbrl_flag=1 のレコードを parse_xbrl が拾って financial_facts に展開する
-- ============================================================
CREATE TABLE IF NOT EXISTS edinet_documents (
  doc_id VARCHAR(20) PRIMARY KEY,             -- S100XXXX
  edinet_code CHAR(6),
  sec_code VARCHAR(10),                       -- 元の 5桁。NULL = 非上場提出者
  doc_type_code VARCHAR(10),
  form_code VARCHAR(20),
  doc_description VARCHAR(500),
  period_start DATE,
  period_end DATE,
  submit_datetime TIMESTAMP NULL,
  xbrl_flag TINYINT(1),
  pdf_flag TINYINT(1),
  csv_flag TINYINT(1),
  withdrawal_status VARCHAR(5),
  parsed_at TIMESTAMP NULL,
  parse_error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sec_code (sec_code),
  INDEX idx_doc_type (doc_type_code),
  INDEX idx_period_end (period_end),
  INDEX idx_submit_datetime (submit_datetime),
  INDEX idx_parsed_at (parsed_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- XBRL ファクト (EAV)
-- 1 doc あたり数百〜千件の fact を 1 行 1 ファクトで格納。
-- なぜ EAV か:
--   - J-GAAP / IFRS / US-GAAP で要素名が異なり、フラットテーブルだと縦に伸ばせない
--   - 連結/単体/前期/前々期 等のコンテキスト次元が爆発する
--   - 検索は (sec_code → doc_id → element_id) 順で hop すれば index で速い
-- 5 年 × 4000 社 × 年 1〜2 報告 ≈ 数 GB 想定。MariaDB で扱える範囲。
--
-- 格納方針:
--   - 数値ファクト (xbrli:decimalItemType / monetaryItemType / pureItemType / sharesItemType) → value_num
--   - 日付ファクト (dateItemType) → value_text に ISO 文字列で
--   - bool / 短い文字列 (会計基準・連結区分など DEI) → value_text
--   - textBlockItemType (会計方針本文 etc.) はスキップ (長文 + parse 目的外)
-- ============================================================
CREATE TABLE IF NOT EXISTS financial_facts (
  doc_id VARCHAR(20) NOT NULL,                -- edinet_documents.doc_id への外部参照 (FK は張らない: parse 順序非依存にする)
  -- element_id / context_ref は XBRL 仕様上 ASCII (XML NCName + ':') なので ASCII collation で十分。
  -- utf8mb4 だと VARCHAR(255)×4 で PK サイズが 3072 bytes 上限に当たるため、ASCII にして 500 まで取れるようにしている。
  -- 実例: ネストしたセグメント次元持ちの context_ref は 200 文字超え得る。
  element_id VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, -- 例: jppfs_cor:NetSales / jpdei_cor:AccountingStandardsDEI
  context_ref VARCHAR(500) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, -- 例: CurrentYearDuration / Prior1YearInstant_NonConsolidatedMember
  period_type ENUM('instant','duration','forever') NOT NULL,
  period_start DATE NULL,                     -- duration の開始 / instant・forever のとき NULL
  period_end DATE NULL,                       -- duration の終了 / instant の日付 / forever のとき NULL
  unit_ref VARCHAR(255) NULL,                 -- arelle が解決した unit 文字列。例: iso4217:JPY / xbrli:shares / iso4217:JPY/xbrli:shares (per-share)
  -- 概念の XBRL item type。arelle が DTS 解決して取得。screening では「monetary だけ」「shares だけ」等で絞るのに使える。
  -- 主な値: monetaryItemType / sharesItemType / pureItemType / percentItemType / decimalItemType /
  --         dateItemType / booleanItemType / stringItemType / textBlockItemType / nonNegativeIntegerItemType etc.
  item_type VARCHAR(50) NULL,
  decimals SMALLINT NULL,                     -- XBRL の decimals 属性 (-6 = 百万円単位)
  value_num DECIMAL(28,4) NULL,               -- 数値ファクト (numeric concept のみ)
  value_text MEDIUMTEXT NULL,                 -- 数値以外 (date / bool / 文字列 / fraction の "num/denom" 表現)
  is_consolidated TINYINT(1) NULL,            -- context dimension の ConsolidatedOrNonConsolidatedAxis から判定 (NonConsolidated=0, Consolidated/無印=1)
  PRIMARY KEY (doc_id, element_id, context_ref),
  INDEX idx_element (element_id),
  INDEX idx_doc (doc_id),
  INDEX idx_item_type (item_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 取得ジョブ管理
-- ============================================================
CREATE TABLE IF NOT EXISTS fetch_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_type VARCHAR(50) NOT NULL,
  target VARCHAR(50),
  from_date DATE,
  to_date DATE,
  row_count INT,
  status VARCHAR(20),
  error_message TEXT,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,
  INDEX idx_job_type (job_type),
  INDEX idx_started_at (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- バックテスト実行
-- 1 run = (strategy × parameters × universe × period × initial_capital × commission) 1 組合せ
-- 結果メトリクス + status を 1 行にサマリ。詳細 (trades / equity curve) は別テーブル。
-- ============================================================
CREATE TABLE IF NOT EXISTS backtest_runs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NULL,                          -- 人間可読タグ。空でも可
  strategy VARCHAR(50) NOT NULL,                   -- 'sma_cross' / 'rsi_mean_reversion' / 'macd_cross' ...
  params JSON NOT NULL,                            -- 戦略固有パラメータ (e.g., {"fast":25,"slow":75})
  universe_spec VARCHAR(255) NOT NULL,             -- 'all' / 'scale:TOPIX Large 70' / 'codes:7203,9984,...' 等の宣言
  universe_codes JSON NOT NULL,                    -- 実際に解決された銘柄リスト
  from_date DATE NOT NULL,
  to_date DATE NOT NULL,
  initial_capital DECIMAL(20,0) NOT NULL DEFAULT 1000000,
  commission_bps INT NOT NULL DEFAULT 10,          -- 片道 (10 = 0.10%)。スリッページ込みの近似

  -- 結果メトリクス (success のときのみ埋まる)
  final_equity DECIMAL(20,2) NULL,
  total_return DECIMAL(12,6) NULL,                 -- 累積リターン (= final/initial - 1)
  cagr DECIMAL(12,6) NULL,
  max_drawdown DECIMAL(12,6) NULL,                 -- max(1 - equity / running_max)
  sharpe DECIMAL(12,6) NULL,                       -- 年率化 (daily * sqrt(252))
  win_rate DECIMAL(12,6) NULL,                     -- winning_trades / closed_trades
  num_trades INT NULL,
  num_bars INT NULL,                               -- 評価日数

  status VARCHAR(20) NOT NULL DEFAULT 'running',   -- running / success / error
  error_message TEXT NULL,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  finished_at TIMESTAMP NULL,

  INDEX idx_strategy (strategy),
  INDEX idx_started (started_at),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 個別取引 (1 run につき複数行)
-- entry → exit の組を 1 行で持つ。期末持ち越しは exit_* が NULL
-- ============================================================
CREATE TABLE IF NOT EXISTS backtest_trades (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  run_id BIGINT NOT NULL,
  code VARCHAR(10) NOT NULL,
  side ENUM('long','short') NOT NULL DEFAULT 'long',
  entry_date DATE NOT NULL,
  entry_price DECIMAL(12,4) NOT NULL,
  exit_date DATE NULL,
  exit_price DECIMAL(12,4) NULL,
  shares INT NOT NULL,
  commission DECIMAL(20,4) NOT NULL DEFAULT 0,     -- 往復合計
  pnl DECIMAL(20,2) NULL,                          -- 手数料込みの実損益
  pnl_pct DECIMAL(12,6) NULL,                      -- pnl / (entry_price * shares)
  exit_reason VARCHAR(30) NULL,                    -- 'signal' / 'end_of_test' (将来 stop_loss / take_profit)

  FOREIGN KEY (run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE,
  INDEX idx_run (run_id),
  INDEX idx_run_code (run_id, code),
  INDEX idx_entry (entry_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- 日次 equity curve (1 run × 評価日数 行)
-- 大量行になり得るので run_id+date を PK、drawdown はその日時点の running max ベース
-- ============================================================
CREATE TABLE IF NOT EXISTS backtest_equity (
  run_id BIGINT NOT NULL,
  trade_date DATE NOT NULL,
  equity DECIMAL(20,2) NOT NULL,
  cash DECIMAL(20,2) NOT NULL,
  position_count INT NOT NULL DEFAULT 0,
  drawdown DECIMAL(12,6) NOT NULL DEFAULT 0,       -- 当日時点の DD (0 = 高値更新中)
  PRIMARY KEY (run_id, trade_date),
  FOREIGN KEY (run_id) REFERENCES backtest_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- テーマ分類 (半導体 / AI / 防衛 …)
--
-- J-Quants にも EDINET にもテーマ分類は無いので自前で持つ。
--   themes        … テーマ定義。**このテーブルがソースオブトゥルース**。
--                    初期投入は sql/themes_seed.sql (`./run.sh themes-seed`、冪等)。
--                    追加・文言修正・廃止 (is_active=0) は直接 UPDATE でもよい
--   theme_members … 銘柄への割当。Gemini API に分類させた結果 (src/classify_themes.py)
--
-- description はそのまま LLM のプロンプトに入る = 分類の判断基準になるので、
-- 「何を含めて何を含めないか」を具体的に書くこと。
--
-- taxonomy_version は themes の MAX(updated_at) 由来。定義をいじると版が上がり、
-- 次回の分類バッチが自動的に全銘柄を再分類する。
-- 1 銘柄が複数テーマに属する多対多 (最大 3)。等ウェイト平均は各テーマ独立に計算するので
-- 多重所属で破綻しない (市場平均の母集団は全上場銘柄のままにすること)。
-- ============================================================
CREATE TABLE IF NOT EXISTS themes (
  theme_code VARCHAR(50) PRIMARY KEY,        -- 'semiconductor' 等の安定キー。RS の時系列はこれで繋ぐ
  theme_name VARCHAR(100) NOT NULL,          -- 画面表示名 (例: 半導体)
  description VARCHAR(500) NOT NULL,         -- 分類基準。LLM にそのまま渡す
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,   -- 0 で分類対象・画面から外す (行は残す)
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS theme_members (
  code VARCHAR(10) NOT NULL,                 -- listed_info.code (4桁)
  theme_code VARCHAR(50) NOT NULL,
  confidence DECIMAL(4,3),                   -- LLM が返す確信度 0.000-1.000
  taxonomy_version VARCHAR(20) NOT NULL,     -- 分類時点の themes 定義版
  model VARCHAR(50),                         -- 使用モデル名
  assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (code, theme_code),
  INDEX idx_theme (theme_code),
  INDEX idx_version (taxonomy_version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ============================================================
-- テーマ分類の台帳 (parse_xbrl の parsed_at と同じ役割)
--
-- theme_members だけだと「分類した結果どのテーマにも該当しなかった銘柄」を
-- 記録できず、毎回 LLM に投げ直すことになる。銘柄ごとに 1 行持って、
-- 差分実行 / 失敗リトライ / 再分類の判定をこのテーブルだけで決める。
--
-- 対象抽出は「台帳に無い or error が残っている or taxonomy_version が古い or
-- 入力 (社名・業種) が変わった」の 4 条件の OR。
-- listed_info への FK は張らない (fetch_listed が毎日 TRUNCATE するため)。
-- ============================================================
CREATE TABLE IF NOT EXISTS theme_classification (
  code VARCHAR(10) PRIMARY KEY,
  taxonomy_version VARCHAR(20) NOT NULL,     -- 分類時点の themes 定義版
  model VARCHAR(50) NOT NULL,
  input_fingerprint CHAR(40) NOT NULL,       -- SHA1(社名|33業種|市場)。社名変更等で再分類する
  n_themes TINYINT NOT NULL DEFAULT 0,       -- 付いたテーマ数 (0 = 該当なしという正常結果)
  error TEXT NULL,                           -- NULL 以外なら次回自動リトライ
  classified_at TIMESTAMP NULL,
  INDEX idx_version (taxonomy_version),
  INDEX idx_error (error(64))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
