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
  INDEX idx_date (trade_date)
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
