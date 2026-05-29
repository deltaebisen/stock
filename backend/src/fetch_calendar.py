"""営業日カレンダーを J-Quants V2 から取得して MariaDB に保存。

V2 エンドポイント: /v2/markets/trading_calendar

実行モード:
- FETCH_MODE=full : 過去 N 年 + 翌年末まで取得 (デフォルト 5 年)
- FETCH_MODE=diff : DB の最新日付以降を取得 (cron 等で月次更新する想定)
- FETCH_FROM / FETCH_TO で範囲を明示指定も可能

差分用途では翌年分まで取りに行く (J-Quants は将来日付の祝日情報も持ってる)。
"""
import os
from datetime import date, datetime, timedelta

import pandas as pd
from sqlalchemy import text

from .db import get_engine
from .jquants_client import JQuantsClient


COLUMN_MAP = {
    "Date": "trade_date",
    "HolidayDivision": "holiday_division",
}


def get_latest_date(engine):
    with engine.connect() as conn:
        row = conn.execute(text("SELECT MAX(trade_date) FROM trading_calendar")).fetchone()
    return row[0] if row and row[0] else None


def upsert_calendar(engine, df: pd.DataFrame) -> int:
    if df.empty:
        return 0
    records = df.to_dict(orient="records")
    sql = text(
        "INSERT INTO trading_calendar (trade_date, holiday_division, is_trading) "
        "VALUES (:trade_date, :holiday_division, :is_trading) "
        "ON DUPLICATE KEY UPDATE "
        "  holiday_division = VALUES(holiday_division), "
        "  is_trading = VALUES(is_trading)"
    )
    with engine.begin() as conn:
        conn.execute(sql, records)
    return len(records)


def main():
    mode = os.environ.get("FETCH_MODE", "full")
    years = int(os.environ.get("FETCH_YEARS", "5"))
    from_env = os.environ.get("FETCH_FROM")
    to_env = os.environ.get("FETCH_TO")

    client = JQuantsClient()
    engine = get_engine()
    today = date.today()
    end_of_next_year = date(today.year + 1, 12, 31)

    if from_env or to_env:
        if not (from_env and to_env):
            raise ValueError("FETCH_FROM と FETCH_TO は両方指定してください")
        from_date = date.fromisoformat(from_env)
        to_date = date.fromisoformat(to_env)
    elif mode == "diff":
        latest = get_latest_date(engine)
        if latest is None:
            print("[fetch_calendar] DB が空なので full モード扱い")
            from_date = today - timedelta(days=365 * years)
        else:
            from_date = latest + timedelta(days=1)
        to_date = end_of_next_year
        if from_date > to_date:
            print(f"[fetch_calendar] 既に最新 ({latest}) まで取得済み")
            return
    else:
        from_date = today - timedelta(days=365 * years)
        to_date = end_of_next_year

    print(f"[fetch_calendar] mode={mode} range={from_date} 〜 {to_date}")

    started = datetime.now()
    raw = client.get_trading_calendar(
        from_date=from_date.isoformat(),
        to_date=to_date.isoformat(),
    )
    if not raw:
        print("[fetch_calendar] データが取得できませんでした")
        return

    df = pd.DataFrame(raw)
    available = {k: v for k, v in COLUMN_MAP.items() if k in df.columns}
    df = df.rename(columns=available)[list(available.values())]
    df["trade_date"] = pd.to_datetime(df["trade_date"]).dt.date
    df["holiday_division"] = df["holiday_division"].astype(str)
    # '1' (営業日) と '2' (東証半日立会) を営業日扱い
    df["is_trading"] = df["holiday_division"].isin(["1", "2"]).astype(int)

    n = upsert_calendar(engine, df)
    print(f"[fetch_calendar] {n} 行 upsert 完了")

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO fetch_log (job_type, from_date, to_date, row_count, status, started_at, finished_at) "
                "VALUES (:jt, :fd, :td, :rc, :st, :sa, :fa)"
            ),
            {
                "jt": "trading_calendar",
                "fd": from_date,
                "td": to_date,
                "rc": n,
                "st": "success",
                "sa": started,
                "fa": datetime.now(),
            },
        )


if __name__ == "__main__":
    main()
