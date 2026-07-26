import Link from "next/link";
import { PERIODS } from "@/lib/grouping";
import { getThemeCatalog, getThemeCoverage, getThemeReturns } from "@/lib/themes";
import { fmtNumber, fmtPercent } from "@/lib/format";
import { byKey, SortTh, type SortDir } from "@/app/_components/SortTh";
import { heatStyle } from "@/app/_components/heat";

export const dynamic = "force-dynamic";

type SearchParams = { sort?: string; dir?: string; cat?: string };


export default async function ThemesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const valid = ["category", "name", "count", ...PERIODS.map((p) => p.key)];
  const sortKey = valid.includes(sp.sort ?? "") ? sp.sort! : "1m";
  const dir: SortDir = sp.dir === "asc" ? "asc" : "desc";

  const [{ asOf, rows: allRows, market }, coverage, catalog] = await Promise.all([
    getThemeReturns(),
    getThemeCoverage(),
    getThemeCatalog(),
  ]);

  // 大分類 (2 段階の上位) でフィルタできるようにする。208 テーマあるので必須
  const catOf = new Map(catalog.map((c) => [c.theme_code, c.category]));
  const categories = [...new Set(catalog.map((c) => c.category))].filter(Boolean);
  const cat = categories.includes(sp.cat ?? "") ? sp.cat! : "";
  const rows = cat ? allRows.filter((r) => catOf.get(r.group_code) === cat) : allRows;

  type Row = (typeof rows)[number];
  const pick =
    sortKey === "category"
      ? (r: Row) => catOf.get(r.group_code) ?? ""
      : sortKey === "name"
      ? (r: Row) => r.group_name
      : sortKey === "count"
        ? (r: Row) => r.count
        : (r: Row) => r.returns[sortKey];
  const sorted = [...rows].sort(byKey(pick, dir));
  const keep = { cat };

  return (
    <>
      <div className="toolbar">
        <strong>テーマ別リターン</strong>
        <span className="muted mono">基準日 {asOf ?? "—"}</span>
        <span style={{ flex: 1 }} />
        <Link href="/themes/rs" className="btn">
          相対強度 →
        </Link>
      </div>

      <div className="toolbar" style={{ gap: 4 }}>
        <Link
          href={`/themes?sort=${sortKey}&dir=${dir}`}
          className={`btn ${cat === "" ? "active" : ""}`}
        >
          すべて
        </Link>
        {categories.map((c) => (
          <Link
            key={c}
            href={`/themes?sort=${sortKey}&dir=${dir}&cat=${encodeURIComponent(c)}`}
            className={`btn ${cat === c ? "active" : ""}`}
          >
            {c}
          </Link>
        ))}
      </div>

      <p className="muted" style={{ margin: "0 0 12px" }}>
        各テーマの構成銘柄の単純平均 (等ウェイト) リターン。分割は adjustment_factor で遡及調整済み。
        <strong>1 銘柄が複数テーマに属する</strong>ので、テーマの銘柄数を足し合わせると上場銘柄数を超える。
        市場平均は全上場銘柄 (重複なし) で計算しているため、テーマを多く持つ銘柄でも偏らない。
        <br />
        分類済み {fmtNumber(coverage.classified)} / {fmtNumber(coverage.listed)} 銘柄・
        {fmtNumber(coverage.assignments)} 割当 ({coverage.themes} テーマ)。
        テーマ定義は DB の themes テーブル、割当は週次バッチ (Gemini) が更新する。
      </p>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <SortTh label="大分類" sortKey="category" sort={sortKey} dir={dir} basePath="/themes" keep={keep} />
              <SortTh label="テーマ" sortKey="name" sort={sortKey} dir={dir} basePath="/themes" keep={keep} />
              <SortTh label="銘柄数" sortKey="count" sort={sortKey} dir={dir} basePath="/themes" keep={keep} num />
              {PERIODS.map((p) => (
                <SortTh
                  key={p.key}
                  label={p.label}
                  sortKey={p.key}
                  sort={sortKey}
                  dir={dir}
                  basePath="/themes"
                  keep={keep}
                  num
                />
              ))}
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderBottom: "2px solid var(--border)" }}>
              <td className="muted">—</td>
              <td>
                <strong>市場平均 (全銘柄等ウェイト)</strong>
              </td>
              <td className="num muted">—</td>
              {PERIODS.map((p) => {
                const v = market[p.key] ?? null;
                return (
                  <td key={p.key} className={`num mono ${v === null ? "" : v > 0 ? "pos" : "neg"}`}>
                    {fmtPercent(v)}
                  </td>
                );
              })}
            </tr>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={PERIODS.length + 3} className="muted" style={{ textAlign: "center", padding: 40 }}>
                  テーマの割当がまだありません (分類バッチ未実行)
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={r.group_code}>
                  <td className="muted" style={{ fontSize: 12 }}>
                    {catOf.get(r.group_code) ?? "—"}
                  </td>
                  <td>
                    <Link href={`/themes/${encodeURIComponent(r.group_code)}`}>
                      {r.group_name}
                    </Link>
                  </td>
                  <td className="num muted mono">{r.count}</td>
                  {PERIODS.map((p) => {
                    const v = r.returns[p.key] ?? null;
                    return (
                      <td key={p.key} className="num mono" style={heatStyle(v)}>
                        {fmtPercent(v)}
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
