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
