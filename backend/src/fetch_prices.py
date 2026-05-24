"""全銘柄の日足をJ-Quants V2から取得してMariaDBに保存。

V2エンドポイント: /v2/equities/bars/daily
カラム名は短縮形 (O, H, L, C, Vo, Va, AdjO, AdjH, AdjL, AdjC, AdjVo, AdjFactor)

戦略:
- date指定で「ある日の全銘柄」を1リクエストで取れる → 日付ループで回す
- 既存データはPRIMARY KEY (code, trade_date) で重複弾く (INSERT IGNORE)

実行モード:
- FETCH_MODE=full : 過去N年分取得 (デフォルト10年)
- FETCH_MODE=diff : DBの最新日付以降を取得 (日次更新用)

レートリミット:
- Light: 60 req/min → 1秒1リクエスト程度に抑える
"""
import os
import time
from datetime import date, datetime, timedelta
import pandas as pd
from sqlalchemy import text

from .jquants_client import JQuantsClient
from .db import get_engine


# V2 API カラム名 → DBカラム名
COLUMN_MAP = {
    "Code": "code",
    "Date": "trade_date",
    "O": "open",
    "H": "high",
    "L": "low",
    "C": "close",
    "Vo": "volume",
    "Va": "turnover_value",
    "AdjFactor": "adjustment_factor",
    "AdjO": "adjustment_open",
    "AdjH": "adjustment_high",
    "AdjL": "adjustment_low",
    "AdjC": "adjustment_close",
    "AdjVo": "adjustment_volume",
}


def get_latest_date(engine):
    with engine.connect() as conn:
        row = conn.execute(text("SELECT MAX(trade_date) FROM daily_quotes")).fetchone()
    return row[0] if row and row[0] else None


def load_trading_days(engine, from_date: date, to_date: date) -> set | None:
    """trading_calendar から営業日 set を返す。テーブルが空なら None (フォールバックさせる)。"""
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT trade_date FROM trading_calendar "
                "WHERE trade_date BETWEEN :fd AND :td AND is_trading = 1"
            ),
            {"fd": from_date, "td": to_date},
        ).fetchall()
    if not rows:
        return None
    return {r[0] for r in rows}


def insert_quotes(engine, df):
    if df.empty:
        return 0
    records = df.to_dict(orient="records")
    # pymysql は NaN を受け付けないので None に変換 (欠損値のある銘柄対策)
    for r in records:
        for k, v in r.items():
            if pd.isna(v):
                r[k] = None
    cols = ",".join([f"`{c}`" for c in df.columns])
    placeholders = ",".join([f":{c}" for c in df.columns])
    sql = text(f"INSERT IGNORE INTO daily_quotes ({cols}) VALUES ({placeholders})")
    with engine.begin() as conn:
        conn.execute(sql, records)
    return len(df)


def daterange(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def fetch_by_date_range(client, engine, from_date: date, to_date: date):
    started = datetime.now()
    total = 0
    fail_count = 0

    # 営業日 set を一括ロード (DB 1 クエリ)。trading_calendar 未取得なら weekday フォールバック
    trading_days = load_trading_days(engine, from_date, to_date)
    if trading_days is None:
        print("[fetch_prices] trading_calendar 未取得 → weekday>=5 フォールバック")
    else:
        print(f"[fetch_prices] trading_calendar から {len(trading_days)} 営業日を取得")

    for d in daterange(from_date, to_date):
        if trading_days is not None:
            if d not in trading_days:
                continue
        else:
            if d.weekday() >= 5:  # 土日スキップ (fallback)
                continue

        date_str = d.strftime("%Y-%m-%d")
        try:
            quotes = client.get_daily_quotes(date=date_str)
            if not quotes:
                # trading_calendar 上では営業日でも上場銘柄 0 件のレア cases (上場前 / 全銘柄 SQ 等)
                continue

            df = pd.DataFrame(quotes)
            available = {k: v for k, v in COLUMN_MAP.items() if k in df.columns}
            df = df.rename(columns=available)[list(available.values())]
            # J-Quants V2 は「4桁ベース + 種別1桁」の5桁を返す。普通株 (末尾0) のみ採用して4桁化
            if "code" in df.columns:
                df["code"] = df["code"].astype(str)
                df = df[df["code"].str.endswith("0")].copy()
                df["code"] = df["code"].str[:4]
            if "trade_date" in df.columns:
                df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date

            n = insert_quotes(engine, df)
            total += n
            print(f"[{date_str}] {n} 行投入 (累計 {total})")
            # レート制御は JQuantsClient._throttle() で実施 (リクエスト単位)

        except Exception as e:
            fail_count += 1
            print(f"[ERROR][{date_str}] {e}")
            try:
                with engine.begin() as conn:
                    conn.execute(
                        text(
                            "INSERT INTO fetch_log (job_type, target, status, error_message, started_at, finished_at) "
                            "VALUES (:jt, :tg, :st, :em, :sa, :fa)"
                        ),
                        {
                            "jt": "daily_quotes",
                            "tg": date_str,
                            "st": "error",
                            "em": str(e)[:1000],
                            "sa": datetime.now(),
                            "fa": datetime.now(),
                        },
                    )
            except Exception:
                pass
            time.sleep(5)

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO fetch_log (job_type, from_date, to_date, row_count, status, started_at, finished_at) "
                "VALUES (:jt, :fd, :td, :rc, :st, :sa, :fa)"
            ),
            {
                "jt": "daily_quotes_bulk",
                "fd": from_date,
                "td": to_date,
                "rc": total,
                "st": "success" if fail_count == 0 else f"partial ({fail_count} errors)",
                "sa": started,
                "fa": datetime.now(),
            },
        )

    return total


def main():
    mode = os.environ.get("FETCH_MODE", "full")
    # Light プランは過去 5 年。Standard なら 10、Premium なら 20 まで上げ可
    years = int(os.environ.get("FETCH_YEARS", "5"))
    from_env = os.environ.get("FETCH_FROM")
    to_env = os.environ.get("FETCH_TO")

    client = JQuantsClient()
    engine = get_engine()
    today = date.today()

    # FETCH_FROM/FETCH_TO が指定されていれば最優先 (1日分テスト等)
    if from_env or to_env:
        if not (from_env and to_env):
            raise ValueError("FETCH_FROM と FETCH_TO は両方指定してください")
        from_date = date.fromisoformat(from_env)
        to_date = date.fromisoformat(to_env)
    elif mode == "diff":
        latest = get_latest_date(engine)
        if latest is None:
            print("[fetch_prices] DBが空なのでfullモード扱い")
            from_date = today - timedelta(days=365 * years)
        else:
            from_date = latest + timedelta(days=1)
            if from_date > today:
                print(f"[fetch_prices] 既に最新 ({latest}) まで取得済み")
                return
        to_date = today
    else:
        from_date = today - timedelta(days=365 * years)
        to_date = today

    print(f"[fetch_prices] mode={mode} range={from_date} 〜 {to_date}")
    total = fetch_by_date_range(client, engine, from_date, to_date)
    print(f"[fetch_prices] 完了: 累計 {total} 行")


if __name__ == "__main__":
    main()
