"""EDINET 公式の事業者コード一覧を取得して edinet_code_mapping に upsert。

ソース: https://disclosure2dl.edinet-fsa.go.jp/searchdocument/codelist/Edinetcode.zip
ZIP の中に EdinetcodeDlInfo.csv (Shift-JIS) が入っている。

CSV カラム (header 名):
  ＥＤＩＮＥＴコード, 提出者種別, 上場区分, 連結の有無, 資本金,
  決算日, 提出者名, 提出者名（英字）, 提出者名（ヨミ）,
  所在地, 提出者業種, 証券コード, 提出者法人番号

数万件しかないので一括ダウンロード + 全件 upsert で十分軽量。
週次〜月次で叩く想定。
"""
import io
import zipfile
from datetime import datetime

import pandas as pd
from sqlalchemy import text

from .db import get_engine
from .edinet_client import EdinetClient


# 元 CSV のカラム名 → DB カラム名 (UTF-8 と Shift-JIS 関係なく一致するように decode 後で比較)
CSV_COLUMN_MAP = {
    "ＥＤＩＮＥＴコード": "edinet_code",
    "提出者種別": "filer_type",
    "上場区分": "listed_division",
    "提出者名": "filer_name",
    "提出者名（英字）": "filer_name_en",
    "提出者業種": "industry",
    "証券コード": "sec_code",
    "提出者法人番号": "corp_number",
}


def parse_csv(zip_bytes: bytes) -> pd.DataFrame:
    """ZIP を解凍して EdinetcodeDlInfo.csv を DataFrame として返す (Shift-JIS)"""
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        # ZIP 内のファイル名は環境依存だが概ね EdinetcodeDlInfo.csv
        csv_name = next(
            (n for n in zf.namelist() if n.endswith(".csv")),
            None,
        )
        if csv_name is None:
            raise RuntimeError(f"CSV ファイルが ZIP に見つかりません: {zf.namelist()}")
        with zf.open(csv_name) as f:
            raw = f.read()

    # EDINET の CSV は Shift-JIS で、1 行目に「ダウンロード日時」等の注釈、2 行目が header
    text_content = raw.decode("cp932", errors="replace")
    df = pd.read_csv(io.StringIO(text_content), header=1, dtype=str)
    return df


def upsert_codes(engine, df: pd.DataFrame) -> int:
    available = {k: v for k, v in CSV_COLUMN_MAP.items() if k in df.columns}
    if "ＥＤＩＮＥＴコード" not in available:
        raise RuntimeError(f"必須カラム ＥＤＩＮＥＴコード が CSV に無い: {df.columns.tolist()[:20]}")

    df2 = df.rename(columns=available)[list(available.values())].copy()
    # NaN → None
    df2 = df2.where(pd.notna(df2), None)
    # sec_code の前後空白除去 (CSV に混入することあり)
    if "sec_code" in df2.columns:
        df2["sec_code"] = df2["sec_code"].map(
            lambda x: x.strip() if isinstance(x, str) and x.strip() else None
        )

    records = df2.to_dict(orient="records")
    if not records:
        return 0

    cols = list(df2.columns)
    col_sql = ", ".join(f"`{c}`" for c in cols)
    placeholders = ", ".join(f":{c}" for c in cols)
    update_sql = ", ".join(f"`{c}` = VALUES(`{c}`)" for c in cols if c != "edinet_code")

    sql = text(
        f"INSERT INTO edinet_code_mapping ({col_sql}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_sql}"
    )
    with engine.begin() as conn:
        # 1 件ずつではなく executemany 相当 (SQLAlchemy が dict list で投げる)
        conn.execute(sql, records)
    return len(records)


def main():
    started = datetime.now()
    print("[fetch_edinet_codes] EDINET コード一覧 ZIP をダウンロード...")
    zip_bytes = EdinetClient.download_code_list()
    print(f"[fetch_edinet_codes] {len(zip_bytes):,} bytes 取得")

    df = parse_csv(zip_bytes)
    print(f"[fetch_edinet_codes] CSV {len(df)} 行 (columns={df.columns.tolist()[:8]}...)")

    engine = get_engine()
    n = upsert_codes(engine, df)
    print(f"[fetch_edinet_codes] {n} 行 upsert 完了")

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO fetch_log (job_type, row_count, status, started_at, finished_at) "
                "VALUES (:jt, :rc, :st, :sa, :fa)"
            ),
            {
                "jt": "edinet_code_mapping",
                "rc": n,
                "st": "success",
                "sa": started,
                "fa": datetime.now(),
            },
        )


if __name__ == "__main__":
    main()
