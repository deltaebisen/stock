import Link from "next/link";
import { PERIODS } from "@/lib/grouping";
import { getThemeCoverage, getThemeReturns } from "@/lib/themes";
import { fmtNumber, fmtPercent } from "@/lib/format";
import { byKey, SortTh, type SortDir } from "@/app/_components/SortTh";
import { heatStyle } from "@/app/_components/heat";

export const dynamic = "force-dynamic";

type SearchParams = { sort?: string; dir?: string; minconf?: string };

/** 信頼度の閾値 (Gemini が返した confidence の足切り) */
const CONF_LEVELS = [
  { v: 0, label: "全部" },
  { v: 0.6, label: "0.6 以上" },
  { v: 0.8, label: "0.8 以上" },
];

export default async function ThemesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const minconf = CONF_LEVELS.some((c) => String(c.v) === sp.minconf) ? Number(sp.minconf) : 0;
  const valid = ["name", "count", ...PERIODS.map((p) => p.key)];
  const sortKey = valid.includes(sp.sort ?? "") ? sp.sort! : "1m";
  const dir: SortDir = sp.dir === "asc" ? "asc" : "desc";

  const [{ asOf, rows, market }, coverage] = await Promise.all([
    getThemeReturns(minconf),
    getThemeCoverage(),
  ]);

  type Row = (typeof rows)[number];
  const pick =
    sortKey === "name"
      ? (r: Row) => r.group_name
      : sortKey === "count"
        ? (r: Row) => r.count
        : (r: Row) => r.returns[sortKey];
  const sorted = [...rows].sort(byKey(pick, dir));
  const keep = { minconf: String(minconf) };

  return (
    <>
      <div className="toolbar">
        <strong>テーマ別リターン</strong>
        <span className="muted mono">基準日 {asOf ?? "—"}</span>
        <span style={{ flex: 1 }} />
        {CONF_LEVELS.map((c) => (
          <Link
            key={c.v}
            href={`/themes?minconf=${c.v}&sort=${sortKey}&dir=${dir}`}
            className={`btn ${minconf === c.v ? "active" : ""}`}
          >
            確信度 {c.label}
          </Link>
        ))}
        <Link href={`/themes/rs?minconf=${minconf}`} className="btn">
          相対強度 →
        </Link>
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
                <td colSpan={PERIODS.length + 2} className="muted" style={{ textAlign: "center", padding: 40 }}>
                  テーマの割当がまだありません (分類バッチ未実行)
                </td>
              </tr>
            ) : (
              sorted.map((r) => (
                <tr key={r.group_code}>
                  <td>
                    <Link href={`/themes/${encodeURIComponent(r.group_code)}?minconf=${minconf}`}>
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
