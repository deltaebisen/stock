"""EDINET の日次提出書類一覧 (documents.json) を取得して edinet_documents に upsert。

実行モード:
- FETCH_MODE=full : FETCH_YEARS 年分 (デフォルト 5 年) を遡って全日叩く
- FETCH_MODE=diff : DB の最新 submit_datetime から今日まで
- FETCH_FROM / FETCH_TO で範囲明示も可能

EDINET の documents.json は 1 日 1 リクエスト。土日も叩く (まれに提出あり)。
レート制御は EdinetClient 側で実施。

5 年フルだと約 1800 リクエスト × 1 秒 = 30 分程度。SSH 切断耐性で detached 実行推奨。
"""
import os
from datetime import date, datetime, timedelta

from sqlalchemy import text

from .db import get_engine
from .edinet_client import EdinetClient


# documents.json results 内のキー → DB カラム
RESULT_FIELDS = {
    "docID": "doc_id",
    "edinetCode": "edinet_code",
    "secCode": "sec_code",
    "docTypeCode": "doc_type_code",
    "formCode": "form_code",
    "docDescription": "doc_description",
    "periodStart": "period_start",
    "periodEnd": "period_end",
    "submitDateTime": "submit_datetime",
    "xbrlFlag": "xbrl_flag",
    "pdfFlag": "pdf_flag",
    "csvFlag": "csv_flag",
    "withdrawalStatus": "withdrawal_status",
}


def get_latest_submit_date(engine) -> date | None:
    with engine.connect() as conn:
        row = conn.execute(
            text("SELECT DATE(MAX(submit_datetime)) FROM edinet_documents")
        ).fetchone()
    return row[0] if row and row[0] else None


def daterange(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def _parse_date(s: str | None) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except (ValueError, TypeError):
        return None


def _parse_datetime(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        # 例: "2024-12-25 18:30"
        return datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None


def _to_int_flag(v) -> int | None:
    if v is None or v == "":
        return None
    try:
        return int(v)
    except (ValueError, TypeError):
        return None


def upsert_documents(engine, results: list[dict]) -> int:
    if not results:
        return 0

    records = []
    for r in results:
        rec = {dest: r.get(src) for src, dest in RESULT_FIELDS.items()}
        rec["period_start"] = _parse_date(rec["period_start"])
        rec["period_end"] = _parse_date(rec["period_end"])
        rec["submit_datetime"] = _parse_datetime(rec["submit_datetime"])
        rec["xbrl_flag"] = _to_int_flag(rec["xbrl_flag"])
        rec["pdf_flag"] = _to_int_flag(rec["pdf_flag"])
        rec["csv_flag"] = _to_int_flag(rec["csv_flag"])
        if not rec.get("doc_id"):
            continue
        records.append(rec)

    if not records:
        return 0

    cols = list(RESULT_FIELDS.values())
    col_sql = ", ".join(f"`{c}`" for c in cols)
    placeholders = ", ".join(f":{c}" for c in cols)
    update_sql = ", ".join(f"`{c}` = VALUES(`{c}`)" for c in cols if c != "doc_id")

    sql = text(
        f"INSERT INTO edinet_documents ({col_sql}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE {update_sql}"
    )
    with engine.begin() as conn:
        conn.execute(sql, records)
    return len(records)


def fetch_range(client: EdinetClient, engine, from_date: date, to_date: date) -> int:
    started = datetime.now()
    total = 0
    fail_count = 0

    for d in daterange(from_date, to_date):
        date_str = d.strftime("%Y-%m-%d")
        try:
            resp = client.list_documents(date_str, doc_type=2)
            results = resp.get("results", []) or []
            n = upsert_documents(engine, results)
            total += n
            if results:
                print(f"[{date_str}] {n} 行 upsert (累計 {total})")
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
                            "jt": "edinet_documents",
                            "tg": date_str,
                            "st": "error",
                            "em": str(e)[:1000],
                            "sa": datetime.now(),
                            "fa": datetime.now(),
                        },
                    )
            except Exception:
                pass

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO fetch_log (job_type, from_date, to_date, row_count, status, started_at, finished_at) "
                "VALUES (:jt, :fd, :td, :rc, :st, :sa, :fa)"
            ),
            {
                "jt": "edinet_documents_bulk",
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
    years = int(os.environ.get("FETCH_YEARS", "5"))
    from_env = os.environ.get("FETCH_FROM")
    to_env = os.environ.get("FETCH_TO")

    client = EdinetClient()
    engine = get_engine()
    today = date.today()

    if from_env or to_env:
        if not (from_env and to_env):
            raise ValueError("FETCH_FROM と FETCH_TO は両方指定してください")
        from_date = date.fromisoformat(from_env)
        to_date = date.fromisoformat(to_env)
    elif mode == "diff":
        latest = get_latest_submit_date(engine)
        if latest is None:
            print("[fetch_edinet_documents] DB が空なので full モード扱い")
            from_date = today - timedelta(days=365 * years)
        else:
            # 最新日も再取得 (途中で取れてない可能性、INSERT IGNORE で重複弾く)
            from_date = latest
        to_date = today
    else:
        from_date = today - timedelta(days=365 * years)
        to_date = today

    print(f"[fetch_edinet_documents] mode={mode} range={from_date} 〜 {to_date}")
    total = fetch_range(client, engine, from_date, to_date)
    print(f"[fetch_edinet_documents] 完了: 累計 {total} 行")


if __name__ == "__main__":
    main()
