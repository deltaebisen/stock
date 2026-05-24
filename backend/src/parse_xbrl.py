"""EDINET XBRL を arelle (XBRL 2.1 reference impl) で parse → financial_facts に展開。

arelle は SEC EDGAR / EDINET / JFSA で実績のある Python の本格 XBRL processor。
DTS 解決 (.xsd / linkbase) ・型ベース値解釈 (concept.baseXbrliType) ・全 context
dimension (explicit + typed) ・tuple 子要素再帰 ・fraction (numerator/denominator) ・
inline XBRL (iXBRL) ・unit 解決 (iso4217:JPY や per-share 形式) すべて arelle 任せ。

実行ループ:
  1. edinet_documents から xbrl_flag=1 AND parsed_at IS NULL を取得
  2. EDINET /documents/{doc_id}?type=1 で ZIP DL
  3. ZIP を temp dir に展開
  4. XBRL/PublicDoc/*.xbrl (なければ *.htm の iXBRL) を arelle で load
     - 初回 DTS 解決時に EDINET 公式タクソノミ (~10MB) を HTTP 取得 → arelle webCache に永続化
  5. modelXbrl.facts から再帰展開 (tuple 子含む) して financial_facts に bulk insert
  6. parsed_at マーク
  7. ModelXbrl.close() でメモリ解放

スピード感:
  - 初回 1 件目: DTS 取得で 30〜60 秒
  - 同タクソノミバージョンの 2 件目以降: 5〜10 秒/件
  - 5 年フル (~数万件) は数時間〜半日。`xbrl-bg` 必須

環境変数:
  DOC_TYPES        対象 doc_type_code カンマ区切り。デフォルト 120,130,140,150,160,170
  LIMIT            1 ジョブで処理する doc 上限 (smoke test 用)
  ARELLE_CACHE_DIR arelle WebCache 配置先 (デフォルト /app/data/arelle-cache)
"""
import io
import logging
import os
import tempfile
import time
import zipfile
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Iterable

from sqlalchemy import text

from arelle import Cntlr

from .db import get_engine
from .edinet_client import EdinetClient


DEFAULT_DOC_TYPES = ("120", "130", "140", "150", "160", "170")
INSERT_BATCH = 500
ARELLE_CACHE_DIR = os.environ.get("ARELLE_CACHE_DIR", "/app/data/arelle-cache")

# arelle の HTTP fetch の最低間隔 (秒)。EDINET 公式の disclosure2dl から
# タクソノミ (.xsd / linkbase) を取りに行く際の burst を抑える。
# EDINET API v2 側 (EdinetClient) と同等の 1 req/sec を default に。
ARELLE_HTTP_MIN_INTERVAL = float(os.environ.get("ARELLE_HTTP_MIN_INTERVAL", "1.0"))

# arelle 標準のログ (validation warning 等) は大量に出るので ERROR 以上のみ表示。
# 致命的失敗は modelManager.load の戻り値 / ModelXbrl.errors で別途検出する。
logging.getLogger("arelle").setLevel(logging.ERROR)


def _install_throttled_opener(cntlr: Cntlr.Cntlr, min_interval: float) -> None:
    """arelle の WebCache.opener.open を min_interval 秒間隔に制限する。

    arelle は DTS 解決時に disclosure2dl.edinet-fsa.go.jp から .xsd / linkbase を
    多数 fetch するが、内蔵 rate limit が無いので 5〜10 req/sec の burst になる。
    EDINET API v2 側の throttle (1 req/sec) と同等の負荷に揃えるために挟む。

    cache hit のときは opener.open が呼ばれないので、実 HTTP のみ throttle される。
    結果として: cache miss burst → 1 req/sec、cache hit → 即時、で済む。
    """
    opener = getattr(cntlr.webCache, "opener", None)
    if opener is None or not hasattr(opener, "open"):
        return  # arelle のバージョン差で内部構造変わったら静かに skip
    original_open = opener.open
    state = {"last": 0.0}

    def throttled_open(*args, **kwargs):
        elapsed = time.monotonic() - state["last"]
        if elapsed < min_interval:
            time.sleep(min_interval - elapsed)
        try:
            return original_open(*args, **kwargs)
        finally:
            state["last"] = time.monotonic()

    opener.open = throttled_open


def make_cntlr() -> Cntlr.Cntlr:
    """arelle Controller を 1 プロセス 1 インスタンス分作る。

    WebCache を docker volume にマウントした ARELLE_CACHE_DIR に永続化することで、
    EDINET 公式タクソノミ (~10MB) の重複 DL を避ける。
    initial DL は workOffline=False で許可、以降は cache hit になる。
    HTTP fetch は ARELLE_HTTP_MIN_INTERVAL 秒間隔に制限。
    """
    Path(ARELLE_CACHE_DIR).mkdir(parents=True, exist_ok=True)
    cntlr = Cntlr.Cntlr(logFileName="logToBuffer", uiLang="ja")
    cntlr.webCache.cacheDir = ARELLE_CACHE_DIR
    cntlr.webCache.workOffline = False
    _install_throttled_opener(cntlr, ARELLE_HTTP_MIN_INTERVAL)
    return cntlr


def fetch_unparsed_docs(engine, doc_types: tuple[str, ...], limit: int | None) -> list[dict]:
    placeholders = ", ".join(f":dt{i}" for i in range(len(doc_types)))
    params = {f"dt{i}": dt for i, dt in enumerate(doc_types)}
    sql = (
        "SELECT doc_id, sec_code, edinet_code, doc_type_code "
        "FROM edinet_documents "
        f"WHERE xbrl_flag = 1 AND parsed_at IS NULL AND doc_type_code IN ({placeholders}) "
        "AND (withdrawal_status IS NULL OR withdrawal_status IN ('0', '')) "
        "ORDER BY submit_datetime ASC"
    )
    if limit:
        sql += f" LIMIT {int(limit)}"
    with engine.connect() as conn:
        rows = conn.execute(text(sql), params).mappings().all()
    return [dict(r) for r in rows]


def walk_facts(facts: Iterable) -> Iterable:
    """top-level facts から再帰で全ファクト yield。tuple 子も平らに出す。"""
    for f in facts:
        yield f
        concept = getattr(f, "concept", None)
        if concept is not None and getattr(concept, "isTuple", False):
            children = getattr(f, "modelTupleFacts", None) or ()
            yield from walk_facts(children)


def _format_qname(qn) -> str:
    """arelle QName → 'prefix:localname'。prefix 不明なら '{URI}local'"""
    if qn is None:
        return ""
    prefix = getattr(qn, "prefix", None)
    local = qn.localName
    if prefix:
        return f"{prefix}:{local}"
    return f"{{{qn.namespaceURI}}}{local}"


def _format_unit(unit) -> str | None:
    """arelle ModelUnit → 'iso4217:JPY' / 'xbrli:shares' / 'iso4217:JPY/xbrli:shares' 等。

    measures は (numerator_qname_list, denominator_qname_list)。
    複数 measure (積) は '*' で連結、分母は '/' 区切り。
    """
    if unit is None:
        return None
    try:
        nums, denoms = unit.measures
    except (TypeError, ValueError):
        return None
    num_str = "*".join(_format_qname(m) for m in nums)
    if denoms:
        denom_str = "*".join(_format_qname(m) for m in denoms)
        return f"{num_str}/{denom_str}" if num_str else f"/{denom_str}"
    return num_str or None


def _detect_consolidated(ctx) -> int | None:
    """context dimension の ConsolidatedOrNonConsolidatedAxis から連結/単体判定。

    EDINET の標準 axis は jppfs_cor:ConsolidatedOrNonConsolidatedAxis。
    explicit member の memberQname を見て NonConsolidated → 0、Consolidated → 1。
    axis 自体が出てこない context は連結扱い (1) にしておく。
    """
    dims = getattr(ctx, "qnameDims", None) or {}
    for dim_qn, dim in dims.items():
        if "ConsolidatedOrNonConsolidatedAxis" not in str(dim_qn):
            continue
        mem = getattr(dim, "memberQname", None)
        if mem is None:
            continue
        mem_str = str(mem)
        if "NonConsolidated" in mem_str:
            return 0
        if "Consolidated" in mem_str:
            return 1
    return 1


def _period_info(ctx) -> tuple[str | None, object, object]:
    if ctx.isInstantPeriod:
        dt = ctx.instantDatetime
        return "instant", None, (dt.date() if dt else None)
    if ctx.isStartEndPeriod:
        sd = ctx.startDatetime
        ed = ctx.endDatetime
        return "duration", (sd.date() if sd else None), (ed.date() if ed else None)
    if ctx.isForeverPeriod:
        return "forever", None, None
    return None, None, None


def _decimals(fact) -> int | None:
    d = getattr(fact, "decimals", None)
    if d is None or d == "INF" or d == "":
        return None
    try:
        return int(d)
    except (ValueError, TypeError):
        return None


def _fact_to_row(fact) -> dict | None:
    concept = getattr(fact, "concept", None)
    if concept is None:
        return None
    if getattr(concept, "isTuple", False):
        # tuple 自身は値を持たない (子は walk_facts で個別 yield 済み)
        return None
    if getattr(fact, "isNil", False):
        return None

    ctx = fact.context
    if ctx is None:
        return None

    period_type, p_start, p_end = _period_info(ctx)
    if period_type is None:
        return None

    element_id = _format_qname(concept.qname)
    if not element_id:
        return None

    item_type = (getattr(concept, "baseXbrliType", None) or "").strip() or None

    # textBlock は item_type または element 名で判定して skip
    if item_type == "textBlockItemType":
        return None
    if concept.qname.localName.endswith("TextBlock"):
        return None

    value_num: Decimal | None = None
    value_text: str | None = None

    if getattr(concept, "isFraction", False):
        # fraction: numerator / denominator (極稀。EDINET 標準では未使用だが仕様準拠で対応)
        try:
            num, denom = fact.fractionValue
            num_d = Decimal(str(num))
            denom_d = Decimal(str(denom))
            if denom_d != 0:
                value_num = num_d / denom_d
            else:
                value_text = f"{num}/{denom}"
        except Exception:
            value_text = (fact.value or "").strip() or None
    elif getattr(concept, "isNumeric", False):
        # numeric: 型変換済み xValue (Decimal 等) → 失敗時は生 text を Decimal にトライ
        xv = getattr(fact, "xValue", None)
        try:
            if xv is not None and not isinstance(xv, (str, bytes)):
                value_num = Decimal(str(xv))
            else:
                value_num = Decimal((fact.value or "").strip())
        except (InvalidOperation, ValueError, TypeError):
            value_text = (fact.value or "").strip() or None
    else:
        # 非数値: date / boolean / string / qname etc.
        xv = getattr(fact, "xValue", None)
        raw = xv if xv is not None else fact.value
        if raw is None:
            return None
        value_text = str(raw).strip() or None
        if not value_text:
            return None

    return {
        "element_id": element_id,
        "context_ref": ctx.id,
        "period_type": period_type,
        "period_start": p_start,
        "period_end": p_end,
        "unit_ref": _format_unit(getattr(fact, "unit", None)),
        "item_type": item_type,
        "decimals": _decimals(fact),
        "value_num": value_num,
        "value_text": value_text,
        "is_consolidated": _detect_consolidated(ctx),
    }


def insert_facts(engine, doc_id: str, facts: list[dict]) -> int:
    if not facts:
        return 0

    # XBRL 仕様上 (element_id, context_ref) は instance 内で一意のはずだが念のため de-dup
    deduped: dict[tuple[str, str], dict] = {}
    for f in facts:
        deduped[(f["element_id"], f["context_ref"])] = f
    rows = [{**f, "doc_id": doc_id} for f in deduped.values()]

    sql = text(
        "INSERT INTO financial_facts "
        "(doc_id, element_id, context_ref, period_type, period_start, period_end, "
        " unit_ref, item_type, decimals, value_num, value_text, is_consolidated) "
        "VALUES "
        "(:doc_id, :element_id, :context_ref, :period_type, :period_start, :period_end, "
        " :unit_ref, :item_type, :decimals, :value_num, :value_text, :is_consolidated) "
        "ON DUPLICATE KEY UPDATE "
        "value_num=VALUES(value_num), value_text=VALUES(value_text), "
        "decimals=VALUES(decimals), unit_ref=VALUES(unit_ref), "
        "item_type=VALUES(item_type), period_start=VALUES(period_start), "
        "period_end=VALUES(period_end), period_type=VALUES(period_type), "
        "is_consolidated=VALUES(is_consolidated)"
    )

    with engine.begin() as conn:
        for i in range(0, len(rows), INSERT_BATCH):
            conn.execute(sql, rows[i:i + INSERT_BATCH])
    return len(rows)


def mark_parsed(engine, doc_id: str, error: str | None) -> None:
    with engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE edinet_documents SET parsed_at = NOW(), parse_error = :err "
                "WHERE doc_id = :did"
            ),
            {"did": doc_id, "err": error},
        )


def _find_instance_path(extracted_dir: Path) -> Path | None:
    """ZIP 展開先から XBRL instance ファイルを探す。

    優先順位:
      1. XBRL/PublicDoc/*.xbrl (正規の XBRL 2.1 instance、全 fact を含む)
      2. XBRL/PublicDoc/*.htm  (iXBRL fallback。.xbrl が無い古い提出向け)

    .xbrl 複数あれば最短名 (= linkbase の *_pre.xbrl 等を避ける)。
    """
    public_doc = extracted_dir / "XBRL" / "PublicDoc"
    if not public_doc.is_dir():
        return None

    xbrl_files = sorted(public_doc.glob("*.xbrl"), key=lambda p: len(p.name))
    if xbrl_files:
        return xbrl_files[0]

    htm_files = sorted(public_doc.glob("*.htm"), key=lambda p: len(p.name))
    if htm_files:
        return htm_files[0]

    return None


def _clear_arelle_log_buffer(cntlr: Cntlr.Cntlr) -> None:
    """arelle の logToBuffer は doc 跨ぎで累積するので明示的にクリア。"""
    try:
        handler = getattr(cntlr, "logHandler", None)
        buf = getattr(handler, "logRecordBuffer", None) if handler else None
        if isinstance(buf, list):
            buf.clear()
    except Exception:
        pass


def process_one(cntlr: Cntlr.Cntlr, client: EdinetClient, engine, doc: dict) -> tuple[bool, int, str | None]:
    doc_id = doc["doc_id"]

    try:
        zip_bytes = client.download_document(doc_id, doc_type=1)
    except Exception as e:
        return False, 0, f"download_failed: {type(e).__name__}: {e}"[:1000]

    with tempfile.TemporaryDirectory(prefix=f"xbrl_{doc_id}_") as tmpdir:
        tmp_path = Path(tmpdir)
        try:
            with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
                zf.extractall(tmp_path)
        except zipfile.BadZipFile as e:
            return False, 0, f"bad_zip: {e}"[:1000]

        instance_path = _find_instance_path(tmp_path)
        if instance_path is None:
            return False, 0, "no_xbrl_instance_in_zip"

        model_xbrl = None
        try:
            model_xbrl = cntlr.modelManager.load(str(instance_path))
        except Exception as e:
            return False, 0, f"arelle_load_failed: {type(e).__name__}: {e}"[:1000]

        if model_xbrl is None:
            return False, 0, "modelxbrl_none"

        try:
            rows: list[dict] = []
            for fact in walk_facts(model_xbrl.facts):
                row = _fact_to_row(fact)
                if row is not None:
                    rows.append(row)
            n = insert_facts(engine, doc_id, rows)
        finally:
            try:
                model_xbrl.close()
            except Exception:
                pass
            _clear_arelle_log_buffer(cntlr)

    return True, n, None


def main():
    doc_types_env = os.environ.get("DOC_TYPES")
    if doc_types_env:
        doc_types = tuple(t.strip() for t in doc_types_env.split(",") if t.strip())
    else:
        doc_types = DEFAULT_DOC_TYPES

    limit_env = os.environ.get("LIMIT")
    limit = int(limit_env) if limit_env else None

    cntlr = make_cntlr()
    client = EdinetClient()
    engine = get_engine()
    started = datetime.now()

    docs = fetch_unparsed_docs(engine, doc_types, limit)
    print(f"[parse_xbrl] 対象 {len(docs)} 件 (doc_types={doc_types}, limit={limit})")

    total_facts = 0
    success = 0
    failed = 0

    for i, doc in enumerate(docs, 1):
        doc_id = doc["doc_id"]
        sec = doc.get("sec_code") or "-"
        # 1 件の予期せぬ例外でジョブ全体が死なないよう最外で囲う
        try:
            ok, n, err = process_one(cntlr, client, engine, doc)
        except Exception as e:
            ok, n, err = False, 0, f"unhandled: {type(e).__name__}: {e}"[:1000]

        if ok:
            success += 1
            total_facts += n
            try:
                mark_parsed(engine, doc_id, None)
            except Exception as e:
                print(f"[{i}/{len(docs)}] {doc_id} mark_parsed failed: {e}")
            print(f"[{i}/{len(docs)}] {doc_id} (sec={sec}) ok: {n} facts")
        else:
            failed += 1
            try:
                mark_parsed(engine, doc_id, err)
            except Exception as e:
                print(f"[{i}/{len(docs)}] {doc_id} mark_parsed failed: {e}")
            print(f"[{i}/{len(docs)}] {doc_id} (sec={sec}) FAIL: {err}")

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO fetch_log (job_type, row_count, status, started_at, finished_at) "
                "VALUES (:jt, :rc, :st, :sa, :fa)"
            ),
            {
                "jt": "xbrl_parse_bulk",
                "rc": total_facts,
                "st": "success" if failed == 0 else f"partial ({failed} failed)",
                "sa": started,
                "fa": datetime.now(),
            },
        )

    print(
        f"[parse_xbrl] 完了: success={success} failed={failed} total_facts={total_facts:,}"
    )


if __name__ == "__main__":
    main()
