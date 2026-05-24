"""上場銘柄一覧をJ-Quants V2から取得してMariaDBに保存

V2エンドポイント: /v2/equities/master
"""
from datetime import datetime
import pandas as pd
from sqlalchemy import text

from .jquants_client import JQuantsClient
from .db import get_engine


# V2 API のカラム名 → DBカラム名
COLUMN_MAP = {
    "Date": "info_date",
    "Code": "code",
    "CoName": "company_name",
    "CoNameEn": "company_name_english",
    "S17": "sector17_code",
    "S17Nm": "sector17_name",
    "S33": "sector33_code",
    "S33Nm": "sector33_name",
    "ScaleCat": "scale_category",
    "Mkt": "market_code",
    "MktNm": "market_name",
    "Mrgn": "margin_code",
    "MrgnNm": "margin_name",
}


def main():
    started = datetime.now()
    client = JQuantsClient()
    info = client.get_listed_info()
    print(f"[fetch_listed] 取得銘柄数: {len(info)}")

    if not info:
        print("[fetch_listed] データが取得できませんでした")
        return

    df = pd.DataFrame(info)
    # APIキーが存在するものだけマッピング(プラン差で出ないカラムがあっても落ちないように)
    available = {k: v for k, v in COLUMN_MAP.items() if k in df.columns}
    df = df.rename(columns=available)[list(available.values())]

    # J-Quants V2 は「4桁ベース + 種別1桁」の5桁を返す。普通株 (末尾0) のみ採用して4桁化
    if "code" in df.columns:
        df["code"] = df["code"].astype(str)
        before = len(df)
        df = df[df["code"].str.endswith("0")].copy()
        df["code"] = df["code"].str[:4]
        dropped = before - len(df)
        if dropped:
            print(f"[fetch_listed] 末尾0以外 (優先株・種類株等) {dropped} 件を除外")

    if "info_date" in df.columns:
        df["info_date"] = pd.to_datetime(df["info_date"]).dt.date

    engine = get_engine()
    with engine.begin() as conn:
        # 銘柄マスタは数千件なので TRUNCATE → INSERT で全置換
        conn.execute(text("TRUNCATE TABLE listed_info"))
        df.to_sql("listed_info", conn, if_exists="append", index=False)

        conn.execute(
            text(
                "INSERT INTO fetch_log (job_type, row_count, status, started_at, finished_at) "
                "VALUES (:jt, :rc, :st, :sa, :fa)"
            ),
            {
                "jt": "listed_info",
                "rc": len(df),
                "st": "success",
                "sa": started,
                "fa": datetime.now(),
            },
        )

    print(f"[fetch_listed] {len(df)} 行 投入完了")


if __name__ == "__main__":
    main()
