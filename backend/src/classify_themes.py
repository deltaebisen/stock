"""上場銘柄を投資テーマに分類する (Gemini API)。

themes テーブルの定義を判断基準として LLM に渡し、該当するテーマを付けて
theme_members に入れる。1 銘柄が複数テーマに属する多対多で、**個数の上限は既定で無し**
(MAX_THEMES に 1 以上を入れたときだけ上限が効く)。

実行ループ:
  1. themes (is_active=1) を読み、taxonomy_version = MAX(updated_at) を決める
  2. listed_info から対象銘柄を取る (ETF = sector33_code '9999' は除外)
     対象 = 台帳に無い / error が残っている / taxonomy_version が古い /
            入力 (社名・業種・市場) が変わった、のいずれか
  3. batch_size 件ずつ Gemini に投げ、theme_members と theme_classification を更新
  4. fetch_log に job_type='theme_classify' で 1 行残す

「どのテーマにも該当しない」は正常な結果なので、台帳に n_themes=0 で記録して
次回以降は投げ直さない (theme_members だけだと毎回再分類してしまう)。

環境変数:
    LIMIT              1 ジョブで分類する銘柄の上限 (smoke test 用)
    GEMINI_BATCH_SIZE  1 リクエストの銘柄数 (デフォルト 40)
    MAX_THEMES         1 銘柄に付ける最大テーマ数。0 = 無制限 (デフォルト)
    GEMINI_MODEL       使用モデル (gemini_client 側の既定は gemini-2.5-flash-lite)

CLI:
    python -m src.classify_themes            # 差分
    python -m src.classify_themes --refresh  # 全銘柄を強制再分類
"""
from __future__ import annotations

import argparse
import hashlib
import os
import sys
from datetime import datetime
from typing import Any

from sqlalchemy import text

from .db import get_engine
from .gemini_client import GeminiClient, GeminiError, GeminiQuotaError, GeminiResponseError

ETF_SECTOR33_CODE = "9999"


def fetch_taxonomy(engine) -> tuple[list[dict], str]:
    """有効なテーマ定義と taxonomy_version (themes の MAX(updated_at)) を返す。"""
    with engine.connect() as conn:
        rows = conn.execute(
            text(
                "SELECT theme_code, theme_name, description FROM themes "
                "WHERE is_active = 1 ORDER BY sort_order, theme_code"
            )
        ).fetchall()
        version = conn.execute(
            text("SELECT DATE_FORMAT(MAX(updated_at), '%Y%m%d%H%i') FROM themes WHERE is_active = 1")
        ).scalar()
    themes = [{"code": r[0], "name": r[1], "description": r[2]} for r in rows]
    return themes, (version or "0")


def fingerprint(row: dict) -> str:
    """分類の入力が変わったかを見るための指紋 (社名・業種・市場)。"""
    raw = "|".join(
        str(row.get(k) or "")
        for k in ("company_name", "company_name_english", "sector33_name", "market_name")
    )
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def fetch_targets(
    engine,
    version: str,
    limit: int | None,
    refresh: bool,
    codes: list[str] | None = None,
) -> list[dict]:
    """分類対象の銘柄を返す。ETF は除外。

    codes を指定するとその銘柄だけを (分類済みでも) 対象にする。検証用。
    """
    sql = (
        "SELECT li.code, li.company_name, li.company_name_english, "
        "       li.sector33_name, li.market_name, li.scale_category, "
        "       tc.taxonomy_version, tc.input_fingerprint, tc.error "
        "  FROM listed_info li "
        "  LEFT JOIN theme_classification tc ON tc.code = li.code "
        " WHERE (li.sector33_code IS NULL OR li.sector33_code <> :etf) "
        " ORDER BY li.code"
    )
    with engine.connect() as conn:
        rows = conn.execute(text(sql), {"etf": ETF_SECTOR33_CODE}).mappings().all()

    wanted = set(codes) if codes else None
    targets: list[dict] = []
    for r in rows:
        row = dict(r)
        if wanted is not None:
            if row["code"] not in wanted:
                continue
            targets.append(row)
            continue
        if not refresh:
            done = (
                row["taxonomy_version"] == version
                and row["error"] is None
                and row["input_fingerprint"] == fingerprint(row)
            )
            if done:
                continue
        targets.append(row)
        if limit and len(targets) >= limit:
            break
    return targets


def build_system_instruction(themes: list[dict], max_themes: int) -> str:
    lines = [
        "あなたは日本株のアナリストです。渡された上場企業を、以下の投資テーマに分類してください。",
        "",
        "# テーマ一覧",
    ]
    for t in themes:
        lines.append(f"- {t['code']} ({t['name']}): {t['description']}")
    cap = (
        f"- 1 銘柄につき最大 {max_themes} 個まで。該当するものから順に付ける"
        if max_themes > 0
        else "- 個数に上限は無い。該当するテーマは全て付ける (5 個以上でも構わない)"
    )
    lines += [
        "",
        "# ルール",
        cap,
        "- ただし主力事業として売上の相当部分 (目安 2 割以上) を占めるテーマに限る。",
        "  関連が薄いものを無理に付けない",
        "- **複数のテーマにまたがる企業は、該当するテーマを全て付けること**。",
        "  1 銘柄 1 テーマに絞ろうとしないこと",
        "  (例: 三菱重工 → defense + machinery + nuclear + power_grid、",
        "        トヨタ自動車 → auto_parts + ev_battery、",
        "        三菱商事 → resources_energy + logistics + renewable)",
        "- どのテーマにも当てはまらない場合は themes を空配列にする。これは正常な結果",
        "- theme_code は必ず一覧にあるものを使う",
        "- **33業種はヒントに過ぎない。テーマを 33業種の言い換えにしないこと**。",
        "  業種が同じでも事業内容が違えば別のテーマになるし、業種をまたぐテーマもある",
        "  (例: 建設業でも太陽光発電所を主力にしていれば renewable、",
        "        商社でも防衛装備を扱っていれば defense を付ける)",
        "- confidence は 0.0〜1.0。企業の事業内容を知らない場合は低い値にする",
        "- 入力された全ての銘柄コードについて、必ず 1 件ずつ結果を返す",
    ]
    return "\n".join(lines)


def build_schema(theme_codes: list[str], max_themes: int) -> dict[str, Any]:
    """theme_code を enum で縛る。表記ゆれと存在しないコードの生成を防ぐ。

    max_themes=0 (無制限) のときは maxItems を付けない。個数はプロンプト側の
    「売上の 2 割以上を占めるものだけ」という基準だけで抑える。
    """
    themes_prop: dict[str, Any] = {
        "type": "ARRAY",
        "items": {
            "type": "OBJECT",
            "properties": {
                "theme_code": {"type": "STRING", "enum": theme_codes},
                "confidence": {"type": "NUMBER"},
            },
            "required": ["theme_code", "confidence"],
        },
    }
    if max_themes > 0:
        themes_prop["maxItems"] = max_themes

    return {
        "type": "ARRAY",
        "items": {
            "type": "OBJECT",
            "properties": {"code": {"type": "STRING"}, "themes": themes_prop},
            "required": ["code", "themes"],
        },
    }


def build_user_text(batch: list[dict]) -> str:
    lines = ["以下の銘柄を分類してください。", "", "コード | 社名 | 英文社名 | 33業種 | 市場 | 規模"]
    for r in batch:
        lines.append(
            " | ".join(
                str(r.get(k) or "-")
                for k in (
                    "code",
                    "company_name",
                    "company_name_english",
                    "sector33_name",
                    "market_name",
                    "scale_category",
                )
            )
        )
    return "\n".join(lines)


def classify_batch(
    client: GeminiClient,
    batch: list[dict],
    themes: list[dict],
    max_themes: int,
) -> dict[str, list[dict]]:
    """1 バッチ分類して {code: [{theme_code, confidence}]} を返す。

    MAX_TOKENS 等でレスポンスが壊れた場合はバッチを半分に割って 1 回だけ再試行する。
    """
    theme_codes = [t["code"] for t in themes]
    try:
        result = client.generate_json(
            build_system_instruction(themes, max_themes),
            build_user_text(batch),
            build_schema(theme_codes, max_themes),
            # 1 銘柄あたり ~40 トークン。バッチを大きくしたら上限も上げないと
            # MAX_TOKENS で切れる
            max_output_tokens=min(60000, max(4096, len(batch) * 80)),
        )
    except GeminiResponseError:
        if len(batch) <= 1:
            raise
        mid = len(batch) // 2
        out = classify_batch(client, batch[:mid], themes, max_themes)
        out.update(classify_batch(client, batch[mid:], themes, max_themes))
        return out

    valid = set(theme_codes)
    sent = {r["code"] for r in batch}
    out: dict[str, list[dict]] = {}
    for item in result if isinstance(result, list) else []:
        code = str(item.get("code", "")).strip()
        if code not in sent:
            continue  # LLM がでっち上げた / 別バッチのコードは捨てる
        assigned = []
        seen = set()
        for t in item.get("themes") or []:
            tc = str(t.get("theme_code", "")).strip()
            if tc not in valid or tc in seen:
                continue
            seen.add(tc)
            try:
                conf = float(t.get("confidence", 0))
            except (TypeError, ValueError):
                conf = 0.0
            assigned.append({"theme_code": tc, "confidence": max(0.0, min(1.0, conf))})
        out[code] = assigned[:max_themes] if max_themes > 0 else assigned
    return out


def save_batch(
    engine,
    batch: list[dict],
    assignments: dict[str, list[dict]],
    version: str,
    model: str,
) -> tuple[int, int]:
    """1 バッチ分を保存する。返り値は (分類できた銘柄数, 付与したテーマ数)。

    レスポンスに含まれなかった銘柄は台帳を更新しない (次回実行で自然に拾われる)。
    """
    n_codes = 0
    n_links = 0
    with engine.begin() as conn:
        for row in batch:
            code = row["code"]
            if code not in assignments:
                continue
            themes = assignments[code]
            conn.execute(text("DELETE FROM theme_members WHERE code = :c"), {"c": code})
            for t in themes:
                conn.execute(
                    text(
                        "INSERT INTO theme_members "
                        "  (code, theme_code, confidence, taxonomy_version, model) "
                        "VALUES (:c, :t, :conf, :v, :m) "
                        "ON DUPLICATE KEY UPDATE confidence = VALUES(confidence), "
                        "  taxonomy_version = VALUES(taxonomy_version), model = VALUES(model)"
                    ),
                    {"c": code, "t": t["theme_code"], "conf": t["confidence"], "v": version, "m": model},
                )
            conn.execute(
                text(
                    "INSERT INTO theme_classification "
                    "  (code, taxonomy_version, model, input_fingerprint, n_themes, error, classified_at) "
                    "VALUES (:c, :v, :m, :fp, :n, NULL, NOW()) "
                    "ON DUPLICATE KEY UPDATE taxonomy_version = VALUES(taxonomy_version), "
                    "  model = VALUES(model), input_fingerprint = VALUES(input_fingerprint), "
                    "  n_themes = VALUES(n_themes), error = NULL, classified_at = NOW()"
                ),
                {"c": code, "v": version, "m": model, "fp": fingerprint(row), "n": len(themes)},
            )
            n_codes += 1
            n_links += len(themes)
    return n_codes, n_links


def mark_error(engine, batch: list[dict], version: str, model: str, message: str) -> None:
    with engine.begin() as conn:
        for row in batch:
            conn.execute(
                text(
                    "INSERT INTO theme_classification "
                    "  (code, taxonomy_version, model, input_fingerprint, n_themes, error) "
                    "VALUES (:c, :v, :m, :fp, 0, :e) "
                    "ON DUPLICATE KEY UPDATE error = VALUES(error)"
                ),
                {
                    "c": row["code"],
                    "v": version,
                    "m": model,
                    "fp": fingerprint(row),
                    "e": message[:1000],
                },
            )


def cleanup_delisted(engine) -> int:
    """listed_info から消えた銘柄の割当を掃除する (FK が張れないので手で消す)。"""
    with engine.begin() as conn:
        r1 = conn.execute(
            text("DELETE FROM theme_members WHERE code NOT IN (SELECT code FROM listed_info)")
        )
        conn.execute(
            text("DELETE FROM theme_classification WHERE code NOT IN (SELECT code FROM listed_info)")
        )
    return r1.rowcount or 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="上場銘柄を投資テーマに分類する")
    parser.add_argument(
        "--refresh", action="store_true", help="分類済みも含めて全銘柄を再分類する"
    )
    parser.add_argument(
        "--codes",
        default=None,
        help="対象銘柄をカンマ区切りで指定 (検証用。分類済みでも再分類する)",
    )
    args = parser.parse_args(argv)

    limit_env = os.environ.get("LIMIT")
    limit = int(limit_env) if limit_env else None
    batch_size = int(os.environ.get("GEMINI_BATCH_SIZE", "40"))
    max_themes = int(os.environ.get("MAX_THEMES", "0"))  # 0 = 無制限

    engine = get_engine()
    started = datetime.now()

    themes, version = fetch_taxonomy(engine)
    if not themes:
        print(
            "[classify_themes] themes テーブルが空です。先に ./run.sh themes-seed を実行してください。",
            file=sys.stderr,
        )
        return 1

    removed = cleanup_delisted(engine)
    codes = [c.strip() for c in args.codes.split(",") if c.strip()] if args.codes else None
    targets = fetch_targets(engine, version, limit, args.refresh, codes)
    print(
        f"[classify_themes] テーマ {len(themes)} 件 / version={version} / "
        f"対象 {len(targets)} 銘柄 (batch={batch_size}, "
        f"max_themes={max_themes if max_themes > 0 else '無制限'}"
        + (f", limit={limit}" if limit else "")
        + (", refresh" if args.refresh else "")
        + ")"
        + (f" / 上場廃止ぶん {removed} 件を掃除" if removed else "")
    )
    if not targets:
        print("[classify_themes] 対象なし")
        return 0

    client = GeminiClient()
    total_codes = 0
    total_links = 0
    failed = 0

    for i in range(0, len(targets), batch_size):
        batch = targets[i : i + batch_size]
        n = i // batch_size + 1
        total_batches = (len(targets) + batch_size - 1) // batch_size
        try:
            assignments = classify_batch(client, batch, themes, max_themes)
        except GeminiQuotaError as e:
            # 待っても当日は回復しないので、残りを未分類のまま残して終了する
            # (台帳が更新されないので、翌日そのまま再実行すれば続きから進む)
            remaining = len(targets) - i
            print(f"[classify_themes] 中断: {e}")
            print(f"[classify_themes] 未分類 {remaining} 銘柄は次回実行に持ち越し")
            break
        except (GeminiError, Exception) as e:  # noqa: BLE001 - 1 バッチの失敗で全体を殺さない
            failed += len(batch)
            mark_error(engine, batch, version, client.model, f"{type(e).__name__}: {e}")
            print(f"[{n}/{total_batches}] FAIL: {type(e).__name__}: {e}")
            continue

        codes, links = save_batch(engine, batch, assignments, version, client.model)
        missing = len(batch) - codes
        total_codes += codes
        total_links += links
        print(
            f"[{n}/{total_batches}] {codes} 銘柄 / {links} 割当"
            + (f" (レスポンス欠落 {missing} 件は次回)" if missing else "")
        )

    with engine.begin() as conn:
        conn.execute(
            text(
                "INSERT INTO fetch_log (job_type, row_count, status, started_at, finished_at) "
                "VALUES (:jt, :rc, :st, :sa, :fa)"
            ),
            {
                "jt": "theme_classify",
                "rc": total_links,
                "st": "success" if failed == 0 else f"partial ({failed} failed)",
                "sa": started,
                "fa": datetime.now(),
            },
        )

    print(
        f"[classify_themes] 完了: {total_codes} 銘柄 / {total_links} 割当 / 失敗 {failed} 銘柄 / "
        f"tokens in={client.prompt_tokens:,} out={client.output_tokens:,}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
