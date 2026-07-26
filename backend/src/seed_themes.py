"""テーマ定義 (themes テーブル) の投入。

`sql/themes_seed.sql` を読んで実行するだけの薄いスクリプト。NAS に mysql
クライアントを入れずに worker コンテナから流せるようにするためにある。
SQL 側が `INSERT ... ON DUPLICATE KEY UPDATE` なので何回流しても同じ状態になる。

実行:
    ./run.sh themes-seed

環境変数:
    THEMES_SQL   投入する SQL ファイル (デフォルト /app/sql/themes_seed.sql)

`themes.description` は分類バッチ (src/classify_themes.py) が LLM に渡す判断基準。
SQL を直して流し直すと updated_at が動き、次回の分類が全銘柄を対象にする。
"""
import os
import sys
from pathlib import Path

from sqlalchemy import text

from .db import get_engine

DEFAULT_SQL_PATH = "/app/sql/themes_seed.sql"


def split_statements(sql: str) -> list[str]:
    """`;` 区切りで文に割る。行コメント (`--`) は除去する。

    themes_seed.sql は文字列リテラル内に `;` を含めない前提 (含めると壊れる)。
    複雑な SQL を流す用途ではないので、これで十分。
    """
    lines = []
    for line in sql.splitlines():
        stripped = line.strip()
        if stripped.startswith("--"):
            continue
        lines.append(line)
    body = "\n".join(lines)
    return [s.strip() for s in body.split(";") if s.strip()]


def main() -> int:
    path = Path(os.environ.get("THEMES_SQL", DEFAULT_SQL_PATH))
    if not path.exists():
        print(f"[seed_themes] SQL が見つかりません: {path}", file=sys.stderr)
        return 1

    statements = split_statements(path.read_text(encoding="utf-8"))
    print(f"[seed_themes] {path} → {len(statements)} 文を実行")

    engine = get_engine()
    with engine.begin() as conn:
        for stmt in statements:
            conn.execute(text(stmt))

    # 無効化されたテーマの割当は残しておくと画面や集計に出てしまうので消す
    with engine.begin() as conn:
        removed = conn.execute(
            text(
                "DELETE FROM theme_members WHERE theme_code IN "
                "(SELECT theme_code FROM themes WHERE is_active = 0)"
            )
        ).rowcount

    with engine.connect() as conn:
        total = conn.execute(text("SELECT COUNT(*) FROM themes")).scalar_one()
        active = conn.execute(
            text("SELECT COUNT(*) FROM themes WHERE is_active = 1")
        ).scalar_one()
        version = conn.execute(
            text("SELECT DATE_FORMAT(MAX(updated_at), '%Y%m%d%H%i') FROM themes")
        ).scalar_one()
    print(
        f"[seed_themes] 完了: themes {total} 件 (有効 {active} 件) / version={version}"
        + (f" / 無効テーマの割当 {removed} 件を削除" if removed else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
